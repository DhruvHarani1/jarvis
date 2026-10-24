'use strict'
/**
 * Screen understanding: "what is on my screen?", "what does this error say?". A picture of the main screen is sent to a vision
 * capable model of YOUR AI provider, so it is off until you switch it on in the tray, and every single use asks first with a
 * click, naming the providers that could receive it. Nothing is saved. What the model says about the screen is treated as
 * untrusted text (a web page can say anything), so it cannot approve or start risky actions.
 */
const obj = (properties, required = []) => ({ type: 'object', properties, required })

/**
 * @param {{capture:()=>Promise<string>, vision:(prompt:string, dataUrl:string)=>Promise<{ok:boolean,text?:string,via?:string,error?:string}>, enabled:()=>boolean, providers:()=>string[]}} d
 */
function createScreenTools(d) {
  return [
    {
      name: 'look_at_screen',
      tier: 'T2',
      requireClick: true,
      title: 'Look at your screen',
      description: 'Look at the user\'s main screen and answer a question about what is visible (for example read an error message, describe a page, find a button). Sends a picture of the screen to the user\'s AI provider, so the user must approve every time.',
      enabled: () => d.enabled(),
      schema: obj({ question: { type: 'string', minLength: 3, maxLength: 300 } }, ['question']),
      describe: (a) => {
        const p = d.providers()
        return `Send a picture of your main screen to ${p.length ? p.join(' or ') : 'your AI provider'} so it can answer:\n"${a.question}"\n\nEverything visible on that screen goes with it, including private things such as mail, chats and passwords that are showing. The picture is not saved.`
      },
      run: async ({ question }) => {
        const img = await d.capture()
        if (!img || !img.startsWith('data:image/')) throw new Error('I could not capture the screen')
        const r = await d.vision(`This is a screenshot of the user's screen. Answer the question briefly in plain words, as if speaking aloud (no markdown, at most four sentences). If you cannot tell, say so. Question: ${question}`, img)
        if (!r.ok) throw new Error(r.error || 'the AI could not look at the picture')
        return { spoken: r.text.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim(), data: { via: r.via }, untrusted: true }
      }
    }
  ]
}

module.exports = { createScreenTools }
