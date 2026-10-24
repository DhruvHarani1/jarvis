'use strict'
/** The morning_briefing tool: the day on one breath. Composed locally (briefing.js); nothing is sent to an AI provider. */
const { compose, gather } = require('../briefing')

/** @param {{google?:any, store?:any, scheduler:{list:()=>any[]}, notifications:()=>any[], battery?:()=>Promise<any>, name:()=>string, now?:()=>Date}} d */
function createBriefingTools(d) {
  return [
    {
      name: 'morning_briefing',
      tier: 'T0',
      description: 'Give the user their briefing for the day: the time and date, the rest of today\'s calendar, unread mail, reminders and notifications that came in. Use when the user says good morning or asks what their day looks like or to be caught up.',
      schema: { type: 'object', properties: {}, required: [] },
      run: async () => {
        const now = d.now ? d.now() : new Date()
        const data = await gather({ google: d.google, store: d.store, scheduler: d.scheduler, notifications: d.notifications, battery: d.battery, now })
        const b = compose(data, { name: d.name(), now })
        // calendar and mail text was written by other people
        return { spoken: b.spoken, data: { lines: b.lines }, untrusted: !!(data.events && data.events.length) || !!(data.unread && data.unread.latest) }
      }
    }
  ]
}

module.exports = { createBriefingTools }
