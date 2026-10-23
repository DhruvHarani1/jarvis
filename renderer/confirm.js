'use strict'
/*
 * The "may I?" box. Risky actions (moving or deleting files, anything that leaves the PC) are never done on a model's say-so:
 * main asks here and waits. Allow / Deny are buttons; when the request does not need a click, a spoken "yes" or "no" works too.
 * If text from a stranger (a message, the clipboard, a file name) has been read in this conversation, only the button counts.
 */
;(function () {
  if (typeof window === 'undefined' || !window.jarvis || !window.jarvis.onConfirmAsk) return
  const $ = (id) => document.getElementById(id)
  const box = $('confirm')
  if (!box) return
  let pending = null // { id, requireClick }

  const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|allow it|confirm|confirmed|proceed|please do|that's right|correct)$/
  const NO = /^(no|nope|nah|cancel|stop|don't|do not|deny|deny it|never mind|negative|abort|not now)$/

  function close() {
    pending = null
    box.hidden = true
    document.body.removeAttribute('data-confirm')
  }
  function answer(yes) {
    if (!pending) return
    const id = pending.id
    close()
    window.jarvis.confirmAnswer(id, yes)
  }

  window.jarvis.onConfirmAsk((req) => {
    pending = { id: req.id, requireClick: !!req.requireClick }
    $('ctitle').textContent = String(req.title || 'Confirm').toUpperCase()
    $('cdetail').textContent = String(req.detail || '')
    $('chint').textContent = req.requireClick ? 'Click ALLOW or DENY. A spoken yes is not enough for this one.' : 'Click ALLOW or DENY, or just say yes or no.'
    box.dataset.tier = req.tier || 'T2'
    box.hidden = false
    document.body.dataset.confirm = '1'
    if (!req.requireClick && window.Voice && window.Voice.armFollowUp) window.Voice.armFollowUp()
  })
  window.jarvis.onConfirmClose((id) => {
    if (pending && pending.id === id) close()
  })
  $('cyes').addEventListener('click', () => answer(true))
  $('cno').addEventListener('click', () => answer(false))

  window.Confirm = {
    /** a spoken or typed reply while a question is open; returns true if it was an answer */
    tryVoice(text) {
      if (!pending) return false
      const t = String(text || '').toLowerCase().replace(/[.!?,]/g, '').trim()
      if (NO.test(t)) {
        answer(false)
        return true
      }
      if (YES.test(t)) {
        if (pending.requireClick) {
          window.Core && window.Core.say('FOR THIS ONE, PLEASE CLICK ALLOW ON SCREEN.', 6000, true)
          return true
        }
        answer(true)
        return true
      }
      return false
    },
    get open() {
      return !!pending
    }
  }
})()
