import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  ImuReportPace,
  StartUpPageCreateResult,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { flushPending, getItem, initStorage, onHydrated, removeItem, setItem } from './storage'

// Display sizing. Heavy box-drawing glyphs (━ ┳ ┻ ●) are 20px wide on
// the G2 LVGL font, and `\u3000` (ideographic space) matches — so a
// 28-char row = 560px and aligns bubble to rail ticks. paddingLength=8
// consumes the remaining 16px symmetrically.
const PAD = 8
const INNER_W_PX = 576 - 2 * PAD         // 560
const SPACE_PX = 5
const RAIL_N = 28
const SWEET_HALF = 2                      // ticks at center±2 → ~60px zone
const VIAL_RANGE_DEG = 30
const LEVEL_TOL_DEG = 0.5
const SMOOTHING = 0.25
const FRAME_MIN_MS = 100
// LVGL renders a short left-side gap that `paddingLength` doesn't cover;
// nudge centered lines right so they sit visually balanced over the rail.
const CENTER_LEFT_FUDGE_PX = 12
const IMU_WATCHDOG_MS = 5000              // re-arm IMU if no frames for this long
// Vertical centering: 5 content lines × 27px = 135px fits in 272px inner
// height (288 − 2×8 padding), so ~68px of top blank space centers it.
// 68 / 27 ≈ 2.5 lines; 3 blanks overshoots slightly high which reads best
// because the angle number is the visual anchor.
const TOP_BLANK_LINES = 3

// Colon-separated keys to mirror books/notes conventions.
const STORE_ROLL = 'level:ref-roll'
const STORAGE_KEYS = [STORE_ROLL]

const RAIL = '\u2501'   // ━
const TICK_T = '\u2533' // ┳
const TICK_B = '\u253B' // ┻
const BUBBLE = '\u25CF' // ●
const IDEO_SP = '\u3000' // fullwidth space, same 20px as rail glyphs

type Vec3 = { x: number; y: number; z: number }

// Seed at rest (gravity straight down → perfectly level) so the first
// frame already shows the vial instead of a "starting" placeholder.
let filtered: Vec3 = { x: 0, y: 0, z: 1 }
let refRoll = 0
let hasRef = false
let lastFrameAt = 0
let lastImuAt = 0
let prevContent = ''
let drawing = false
let pendingFrame: string | null = null
let rearming = false

const MOCK = new URLSearchParams(location.search).has('mock')

const bridge = await waitForEvenAppBridge()

// Hydration-lag workaround: the initial `getLocalStorage` after
// `waitForEvenAppBridge` resolves can return '' even for previously
// saved keys. We listen for late arrivals and re-render when the real
// value lands. `initStorage` is kicked off without `await` so we can
// start rendering the container immediately with the default zero.
onHydrated((key, value) => {
  if (key !== STORE_ROLL) return
  const r = Number(value)
  if (!Number.isFinite(r)) return
  refRoll = r
  hasRef = true
  console.log('[level] hydrated roll:', r)
  updateCalStatus()
  void draw(renderFrame())
})

void initStorage(bridge, STORAGE_KEYS).then(() => {
  const storedRoll = getItem(STORE_ROLL)
  console.log('[level] init complete, storedRoll =', JSON.stringify(storedRoll))
})

function updateCalStatus() {
  const el = document.getElementById('calStatus')
  if (!el) return
  const roll = hasRef ? `${refRoll.toFixed(2)}°` : 'none'
  el.innerHTML = `Saved offset: <strong>${roll}</strong>`
}

const initialContent = renderFrame()
const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  paddingLength: PAD,
  containerID: 1,
  containerName: 'level',
  content: initialContent,
  isEventCapture: 1,
})
prevContent = initialContent

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)

if (result !== StartUpPageCreateResult.success) {
  throw new Error(`createStartUpPageContainer failed (${result})`)
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sys = event.sysEvent

  // IMU first: `imuData` only appears on IMU reports. Must precede click
  // checks so protobuf zero-coalescing doesn't treat every non-click
  // event as a click.
  if (sys?.imuData) {
    const { y = 0, z = 0 } = sys.imuData
    processImu(y, z)
    return
  }

  const sysET = sys ? sys.eventType ?? 0 : -1
  const textET = event.textEvent ? event.textEvent.eventType ?? 0 : -1

  if (sysET === OsEventTypeList.DOUBLE_CLICK_EVENT || textET === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    void (async () => {
      await flushPending()
      await bridge.imuControl(false)
      await bridge.shutDownPageContainer(1)
    })()
    return
  }

  if (sysET === OsEventTypeList.CLICK_EVENT || textET === OsEventTypeList.CLICK_EVENT) {
    void setZeroHere()
    return
  }

  if (sysET === OsEventTypeList.SYSTEM_EXIT_EVENT || sysET === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    void bridge.imuControl(false)
    unsubscribe()
  }
})

if (MOCK) {
  startMockImu()
} else {
  await bridge.imuControl(true, ImuReportPace.P100)
  lastImuAt = performance.now()
}

// WebView reset button — clears the persisted calibration.
const resetBtn = document.getElementById('reset') as HTMLButtonElement | null
const resetStatus = document.getElementById('resetStatus')
resetBtn?.addEventListener('click', () => {
  resetBtn.disabled = true
  removeItem(STORE_ROLL)
  refRoll = 0
  hasRef = false
  updateCalStatus()
  if (resetStatus) {
    resetStatus.textContent = 'cleared'
    setTimeout(() => { if (resetStatus) resetStatus.textContent = '' }, 2000)
  }
  void draw(renderFrame())
  resetBtn.disabled = false
})


// Show current calibration state in the WebView from the start.
updateCalStatus()

// Watchdog: if IMU frames stop arriving (power-save, firmware dropped
// the subscription, app backgrounded then resumed), re-arm the stream.
if (!MOCK) {
  setInterval(async () => {
    if (rearming) return
    const since = performance.now() - lastImuAt
    if (since < IMU_WATCHDOG_MS) return
    rearming = true
    try {
      await bridge.imuControl(false)
      await bridge.imuControl(true, ImuReportPace.P100)
      lastImuAt = performance.now()
    } finally {
      rearming = false
    }
  }, 1000)
}

// Common entry point for real and mocked IMU samples.
function processImu(y: number, z: number) {
  lowpass({ x: 0, y, z })
  const now = performance.now()
  lastImuAt = now
  if (now - lastFrameAt >= FRAME_MIN_MS) {
    lastFrameAt = now
    void draw(renderFrame())
  }
}

// Drives the IMU processor from a WebView slider so the app can be
// screenshotted in the simulator, which doesn't emit IMU events.
function startMockImu() {
  const section = document.getElementById('mockSection') as HTMLElement | null
  const slider = document.getElementById('mockRoll') as HTMLInputElement | null
  const valueEl = document.getElementById('mockRollValue')
  const resetSliderBtn = document.getElementById('mockZero') as HTMLButtonElement | null
  const levelBtn = document.getElementById('mockLevel') as HTMLButtonElement | null
  if (section) section.style.display = ''
  const mockFooter = document.getElementById('mockFooter') as HTMLElement | null
  if (mockFooter) mockFooter.style.display = ''
  if (!slider) return

  const updateLabel = () => { if (valueEl) valueEl.textContent = `${Number(slider.value).toFixed(1)}\u00B0` }
  slider.addEventListener('input', updateLabel)
  resetSliderBtn?.addEventListener('click', () => { slider.value = '0'; updateLabel() })
  levelBtn?.addEventListener('click', () => { slider.value = '0'; updateLabel() })
  updateLabel()

  setInterval(() => {
    const rollDeg = Number(slider.value)
    const r = (rollDeg * Math.PI) / 180
    // Gravity vector with pitch=0: y = sin(roll), z = cos(roll).
    processImu(Math.sin(r), Math.cos(r))
  }, 100)
}

function lowpass(s: Vec3) {
  filtered.y = filtered.y * (1 - SMOOTHING) + s.y * SMOOTHING
  filtered.z = filtered.z * (1 - SMOOTHING) + s.z * SMOOTHING
}

function computeRoll(v: Vec3): number {
  return (Math.atan2(v.y, v.z) * 180) / Math.PI
}

function fmtDeg(deg: number): string {
  const sign = deg >= 0 ? '+' : '\u2212' // U+2212 real minus, matches '+' weight
  const abs = Math.abs(deg).toFixed(1).padStart(4, '0')
  return `${sign}${abs}\u00B0`
}

function rail(tick: string): string {
  const center = Math.floor(RAIL_N / 2)
  let s = ''
  for (let i = 0; i < RAIL_N; i++) {
    s += (i === center - SWEET_HALF || i === center + SWEET_HALF) ? tick : RAIL
  }
  return s
}

function bubbleRow(angle: number): string {
  const clamped = Math.max(-VIAL_RANGE_DEG, Math.min(VIAL_RANGE_DEG, angle))
  const center = Math.floor(RAIL_N / 2)
  const pos = Math.round((clamped / VIAL_RANGE_DEG) * center + center)
  let s = ''
  for (let i = 0; i < RAIL_N; i++) s += i === pos ? BUBBLE : IDEO_SP
  return s
}

function centered(s: string): string {
  const padPx = (INNER_W_PX - getTextWidth(s)) / 2 + CENTER_LEFT_FUDGE_PX
  const pad = Math.max(0, Math.round(padPx / SPACE_PX))
  return ' '.repeat(pad) + s
}

function renderFrame(): string {
  const roll = computeRoll(filtered) - refRoll
  const isLevel = Math.abs(roll) < LEVEL_TOL_DEG
  const header = isLevel ? '\u2605 LEVEL \u2605' : fmtDeg(roll)
  const hint = `Tap \u2192 zero${hasRef ? ' \u2713' : ''}` // →
  const blanks = Array(TOP_BLANK_LINES).fill('')
  return [
    ...blanks,
    centered(header),
    rail(TICK_T),
    bubbleRow(-roll), // bubble rises to the high side, like a real spirit level
    rail(TICK_B),
    centered(hint),
  ].join('\n')
}

async function draw(text: string) {
  if (text === prevContent) return
  if (drawing) {
    pendingFrame = text
    return
  }
  drawing = true
  try {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        contentOffset: 0,
        contentLength: Math.max(prevContent.length, text.length),
        content: text,
      }),
    )
    prevContent = text
  } finally {
    drawing = false
    const next = pendingFrame
    pendingFrame = null
    if (next && next !== prevContent) void draw(next)
  }
}

async function setZeroHere() {
  refRoll = computeRoll(filtered)
  hasRef = true
  updateCalStatus()
  void draw(renderFrame())
  // Await the write so a follow-up double-tap-to-exit can't tear down
  // the WebView before the companion has persisted the value.
  await setItem(STORE_ROLL, String(refRoll))
  console.log(`[level] setZero persisted: ${STORE_ROLL} = ${refRoll}`)
}

// Backup write on any lifecycle event that might kill the WebView. The
// browser localStorage write inside setItem is synchronous, so even if
// the bridge write gets cut off, the fallback can survive an .ehpk
// restart in companion versions that keep web storage around.
const lifecycleSave = () => {
  if (!hasRef) return
  try { window.localStorage.setItem(STORE_ROLL, String(refRoll)) } catch { /* ignore */ }
}
window.addEventListener('visibilitychange', lifecycleSave)
window.addEventListener('pagehide', lifecycleSave)
window.addEventListener('beforeunload', lifecycleSave)
