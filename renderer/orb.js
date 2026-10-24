'use strict'
/*
 * The Jarvis orb: a glowing core inside turning rings, drawn on a canvas. It shows what he is doing:
 *   idle (slow breathing), listening (rings open and follow your voice level), thinking (amber, rings spin fast),
 *   speaking (core pulses with a swell), asking permission (gold, steady pulse), error (red flicker).
 * The state comes from the page itself (body[data-voice], body[data-speaking], the open "may I?" box); nothing here talks to the main process.
 */
;(function () {
  const canvas = document.getElementById('orb')
  const label = document.getElementById('state')
  if (!canvas || !canvas.getContext) return
  const g = canvas.getContext('2d')
  const CX = canvas.width / 2
  const CY = canvas.height / 2
  const NAMES = { idle: 'STANDING BY', listening: 'LISTENING', heard: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', asking: 'AWAITING YOUR OK', error: 'SOMETHING WENT WRONG' }
  const TONE = { idle: [56, 200, 255], listening: [90, 235, 255], thinking: [255, 207, 92], speaking: [120, 220, 255], asking: [255, 207, 92], error: [255, 77, 109] }
  const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches // slower, gentler motion for people who ask Windows for it
  let t = 0
  let shown = ''
  let energy = 0 // smoothed 0..1, what the rings follow
  let flash = 0 // brief boost when the state changes

  function stateNow() {
    const b = document.body
    if (b.dataset.error === '1') return 'error'
    const c = document.getElementById('confirm')
    if (c && !c.hidden) return 'asking'
    const v = b.dataset.voice
    if (v === 'listening' || v === 'heard') return 'listening'
    if (v === 'thinking') return 'thinking'
    if (b.dataset.speaking === '1') return 'speaking'
    return 'idle'
  }

  function frame() {
    t += calm ? 0.004 : 0.016
    const st = stateNow()
    if (st !== shown) {
      shown = st
      flash = 1
      document.body.dataset.orb = st
      if (label) label.textContent = NAMES[st]
    }
    flash *= 0.94
    const lvl = parseFloat(document.body.style.getPropertyValue('--lvl')) || 0
    const goal = st === 'listening' ? 0.25 + lvl * 0.9 : st === 'speaking' ? 0.45 + 0.3 * Math.sin(t * 7) * Math.sin(t * 2.3) + 0.1 * Math.random() : st === 'thinking' ? 0.4 : st === 'asking' ? 0.35 + 0.15 * Math.sin(t * 4) : st === 'error' ? 0.3 + 0.3 * Math.random() : 0.12 + 0.05 * Math.sin(t * 1.4)
    energy += (goal - energy) * 0.12
    const [r, gr, bl] = TONE[st]
    const col = (a) => `rgba(${r},${gr},${bl},${a})`
    const spin = st === 'thinking' ? 3.2 : st === 'listening' ? 1.2 : 0.5

    g.clearRect(0, 0, canvas.width, canvas.height)
    g.globalCompositeOperation = 'lighter'

    // soft glow behind everything
    const glow = g.createRadialGradient(CX, CY, 10, CX, CY, 150)
    glow.addColorStop(0, col(0.32 + energy * 0.35 + flash * 0.2))
    glow.addColorStop(0.45, col(0.1 + energy * 0.12))
    glow.addColorStop(1, col(0))
    g.fillStyle = glow
    g.fillRect(0, 0, canvas.width, canvas.height)

    // outer tick ring
    g.save()
    g.translate(CX, CY)
    g.rotate(t * 0.15 * spin)
    g.strokeStyle = col(0.35)
    g.lineWidth = 1
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2
      const long = i % 6 === 0
      const r0 = 138
      const r1 = r0 + (long ? 9 : 4)
      g.beginPath()
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
      g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1)
      g.stroke()
    }
    g.restore()

    // three arcs that turn at different speeds and breathe open with the energy
    const rings = [
      { rad: 118, w: 2.2, gaps: 3, sp: 0.6, a: 0.7 },
      { rad: 96, w: 1.6, gaps: 5, sp: -0.9, a: 0.55 },
      { rad: 74, w: 3, gaps: 2, sp: 1.3, a: 0.8 }
    ]
    for (const [i, ring] of rings.entries()) {
      const rad = ring.rad + energy * (6 + i * 3) * Math.sin(t * 2 + i)
      const seg = (Math.PI * 2) / ring.gaps
      const len = seg * (0.62 + 0.12 * energy)
      g.strokeStyle = col(ring.a)
      g.lineWidth = ring.w
      g.shadowColor = col(1)
      g.shadowBlur = 8 + energy * 14
      g.lineCap = 'round'
      for (let k = 0; k < ring.gaps; k++) {
        const a0 = t * ring.sp * spin + k * seg
        g.beginPath()
        g.arc(CX, CY, rad, a0, a0 + len)
        g.stroke()
      }
    }
    g.shadowBlur = 0

    // dots orbiting while he thinks
    if (st === 'thinking') {
      for (let k = 0; k < 8; k++) {
        const a = t * 3 + (k / 8) * Math.PI * 2
        g.fillStyle = col(0.9 - k * 0.1)
        g.beginPath()
        g.arc(CX + Math.cos(a) * 58, CY + Math.sin(a) * 58, 3.4 - k * 0.3, 0, Math.PI * 2)
        g.fill()
      }
    }

    // the core
    const core = 30 + energy * 22 + flash * 6
    const cg = g.createRadialGradient(CX, CY, 0, CX, CY, core * 1.8)
    cg.addColorStop(0, 'rgba(255,255,255,0.95)')
    cg.addColorStop(0.28, col(0.95))
    cg.addColorStop(1, col(0))
    g.fillStyle = cg
    g.beginPath()
    g.arc(CX, CY, core * 1.8, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = col(0.9)
    g.lineWidth = 2
    g.beginPath()
    g.arc(CX, CY, core, 0, Math.PI * 2)
    g.stroke()

    g.globalCompositeOperation = 'source-over'
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})()
