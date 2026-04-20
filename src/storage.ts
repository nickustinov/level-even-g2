// SDK-backed storage with hydration-lag retry.
//
// Observed quirk on real glasses: immediately after `waitForEvenAppBridge`
// resolves, the first `getLocalStorage(key)` for a previously-saved key
// returns '' even though the value IS persisted on the companion. The
// value becomes readable ~1-3 seconds later. We retry until a value
// appears or a deadline passes, then surface it via a ready callback
// so the caller can re-render with the real calibration.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

let bridge: EvenAppBridge | null = null
const cache = new Map<string, string>()
const pending = new Set<Promise<unknown>>()
const listeners = new Set<(key: string, value: string) => void>()
let ready = false

/**
 * Kick off the hydration-tolerant init. Resolves once either (a) all
 * keys have a value or (b) the retry deadline elapses. Emits
 * `onHydrated` for each key that arrives late.
 */
export async function initStorage(
  b: EvenAppBridge,
  keys: string[],
  { maxWaitMs = 4000, pollMs = 200 }: { maxWaitMs?: number; pollMs?: number } = {},
): Promise<void> {
  bridge = b
  const start = Date.now()
  const pendingKeys = new Set(keys)
  const attempts = new Map<string, number>()

  while (pendingKeys.size > 0 && Date.now() - start < maxWaitMs) {
    for (const key of [...pendingKeys]) {
      try {
        const v = await b.getLocalStorage(key)
        attempts.set(key, (attempts.get(key) ?? 0) + 1)
        if (v) {
          cache.set(key, v)
          pendingKeys.delete(key)
          for (const cb of listeners) cb(key, v)
          console.log(`[storage] hydrated ${key} after ${attempts.get(key)} attempt(s)`)
        }
      } catch (e) {
        console.warn(`[storage] getLocalStorage threw for ${key}:`, e)
      }
    }
    if (pendingKeys.size > 0) await new Promise(r => setTimeout(r, pollMs))
  }

  for (const key of pendingKeys) {
    console.log(`[storage] gave up on ${key} after ${attempts.get(key) ?? 0} attempt(s) in ${Date.now() - start}ms`)
  }
  ready = true
}

export function onHydrated(cb: (key: string, value: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function isStorageReady(): boolean {
  return ready
}

export function getItem(key: string): string | null {
  return cache.get(key) ?? null
}

export async function setItem(key: string, value: string): Promise<void> {
  cache.set(key, value)
  if (!bridge) return
  const p = (async () => {
    try {
      const ok = await bridge!.setLocalStorage(key, value)
      const verify = await bridge!.getLocalStorage(key)
      if (!ok || verify !== value) {
        console.warn(`[storage] setItem(${key}) mismatch: ok=${ok} readback=${JSON.stringify(verify)}`)
      } else {
        console.log(`[storage] setItem(${key}) = ${value} verified`)
      }
    } catch (e) {
      console.warn(`[storage] setLocalStorage threw for ${key}:`, e)
    }
  })()
  pending.add(p)
  try { await p } finally { pending.delete(p) }
}

export async function removeItem(key: string): Promise<void> {
  cache.delete(key)
  if (!bridge) return
  try { await bridge.setLocalStorage(key, '') } catch { /* ignore */ }
}

export async function flushPending(): Promise<void> {
  if (pending.size === 0) return
  await Promise.allSettled([...pending])
}
