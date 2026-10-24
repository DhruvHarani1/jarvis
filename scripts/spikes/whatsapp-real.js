'use strict'
// Real, harmless check of the WhatsApp path: opens a chat link for a fictional number and only LOOKS at which window is in front. It never presses Enter.
const { spawn } = require('node:child_process')
const psReal = require('../../tools/ps')
const { PS_SEND_KEY, WHATSAPP_PROCESSES } = require('../../tools/chatapps')
spawn('cmd', ['/c', 'start', '', 'whatsapp://send?phone=15550100123&text=Jarvis%20test%2C%20not%20sent'], { windowsHide: true, stdio: 'ignore' })
psReal.run(PS_SEND_KEY, { allowed: WHATSAPP_PROCESSES, enter: false, waitMs: 9000, settleMs: 800 }, { timeoutMs: 40000 }).then((o) => console.log(o), (e) => console.log('ERR', e.message))
