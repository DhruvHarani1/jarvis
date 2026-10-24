'use strict'
/*
 * The HUD strip of the main window: a live waveform (your voice while he listens, a gentle swell while he speaks, a faint line
 * when idle) and two small gauges for this PC's CPU and memory (numbers come from the main process every few seconds, only
 * while the window is visible).
 */
;(function () {
  if (typeof window === 'undefined' || !window.jarvis) return
  const canvas = document.getElementById('wave')
  const cpu = document.getElementById('gcpu')
  const ram = document.getElementById('gram')
  if (window.jarvis.onHudStats && cpu && ram) {
    window.jarvis.onHudStats((s) => {
      for (const [el, v] of [[cpu, s.cpu], [ram, s.ram]]) {
        const pct = Math.max(0, Math.min(100, Math.round(v)))
        el.querySelector('i').style.width = pct + '%'
        el.querySelector('b').textContent = pct + '%'
        el.dataset.level = pct > 85 ? 'high' : pct > 65 ? 'mid' : 'low'
      }
    })
  }
  if (!canvas || !canvas.getContext) return
  const g = canvas.getContext('2d')
  const BARS = 56
  const levels = new Array(BARS).fill(0)
  let t = 0
  function resize() {
    const r = canvas.getBoundingClientRect()
    canvas.width = Math.max(100, Math.round(r.width))
    canvas.height = Math.max(20, Math.round(r.height))
  }
  window.addEventListener('resize', resize)
  resize()
  function frame() {
    t += 0.06
    const b = document.body
    const state = b.dataset.voice
    let target
    if (state === 'listening' || state === 'heard') target = Math.min(1, parseFloat(b.style.getPropertyValue('--lvl')) || 0.06) * (0.6 + 0.4 * Math.random())
    else if (b.dataset.speaking === '1') target = 0.35 + 0.3 * Math.sin(t * 3) * Math.sin(t * 1.3) + 0.15 * Math.random()
    else if (state === 'thinking') target = 0.15 + 0.1 * Math.sin(t * 6)
    else target = 0.04 + 0.02 * Math.sin(t)
    levels.shift()
    levels.push(Math.max(0.02, target))
    const w = canvas.width
    const h = canvas.height
    g.clearRect(0, 0, w, h)
    const gap = 3
    const bw = (w - gap * (BARS - 1)) / BARS
    const hot = state === 'thinking' ? '#ffcf5c' : '#38c8ff'
    for (let i = 0; i < BARS; i++) {
      const edge = Math.sin((Math.PI * (i + 0.5)) / BARS) // taller in the middle
      const bh = Math.max(2, levels[i] * h * (0.35 + 0.65 * edge))
      g.fillStyle = hot
      g.globalAlpha = 0.35 + 0.65 * levels[i]
      g.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh)
    }
    g.globalAlpha = 1
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})()
