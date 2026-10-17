'use strict'
// Unit tests for the notification inbox parsers. Run: npm run test:unit
const assert = require('node:assert/strict')
const { parseToast, appName, decodeXml } = require('../notifications')

const xml = `<toast launch="x"><visual><binding template="ToastGeneric"><text>Mum</text><text>Dinner at 8? &amp; bring milk &#128512;</text><text hint-maxLines="1">Reply</text></binding></visual></toast>`
const t = parseToast(Buffer.from(xml, 'utf8'))
assert.equal(t.title, 'Mum')
assert.equal(t.body, 'Dinner at 8? & bring milk 😀 Reply')

// UTF-16 payloads (some apps) decode too
assert.equal(parseToast(Buffer.from(xml, 'utf16le')).title, 'Mum')
assert.equal(parseToast('<toast><visual></visual></toast>'), null, 'no text => nothing to show')
assert.equal(parseToast(Buffer.from('<toast><visual><binding><text>  A  \n  B </text></binding></visual></toast>')).title, 'A B')
assert.equal(parseToast('<toast><binding><text><b>bold</b> x</text></binding></toast>').title, 'bold x', 'inner tags stripped')

assert.equal(decodeXml('&lt;a&gt; &quot;q&quot; &apos;s&apos; &#x41;'), '<a> "q" \'s\' A')

assert.equal(appName('5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App'), 'WhatsApp')
assert.equal(appName('Microsoft.Windows.Explorer'), 'Explorer')
assert.equal(appName('com.squirrel.slack.slack'), 'Slack')
assert.equal(appName('Chrome'), 'Chrome')
assert.equal(appName('Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!https://www.youtube.com/'), 'youtube.com')
assert.equal(appName('C:\\Program Files\\Foo\\Bar.exe'), 'Bar')
assert.equal(appName(''), 'Windows')
assert.equal(appName('dev.lyra.companion'), 'Lyra')
assert.equal(appName('{49A2BF0D-E1C5-47EB-8B7C-B307007CF869}'), 'System')
assert.equal(appName('MSEdge'), 'MSEdge')

console.log('notifications: ALL PASS')
