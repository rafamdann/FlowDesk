// Dictation for every text box in FlowDesk.
//
// The browser records; this turns the recording into text. It lives here
// rather than in the page for two reasons: the API key must never reach the
// browser, and the browser's own speech recognition does not work inside the
// desktop app (Electron ships without the keys Chrome uses for it), so it
// would have worked on the web and silently failed on the desktop.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// The better model first; whisper-1 only if the account cannot use it, so a
// model that is unavailable degrades dictation instead of breaking it.
const MODELS = ['gpt-4o-transcribe', 'whisper-1']

// OpenAI's own ceiling for one file.
const MAX_BYTES = 25 * 1024 * 1024

// No standing prompt. There was one, describing the work, and on a recording
// with nothing in it the model read it back as if it had been said. The only
// hint now is the team's dictionary — names it must spell right — and the
// page does not send silence at all.

// What the models are known to invent from silence or breath: subtitle
// credits and sign-offs from the videos they were trained on.
const PHANTOMS = /amara\.org|legendas pela comunidade|thanks? (you )?for watching|obrigad[oa] por (assistir|ver)/i

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) {
    return json({ error: 'Dictation is not configured yet: OPENAI_API_KEY is not set on this project.' }, 503)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  // Signed-in people only: every request is paid for.
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
  const token = authHeader.replace(/^Bearer\s+/i, '')
  const { data: { user }, error: userErr } = await db.auth.getUser(token)
  if (userErr || !user) return json({ error: 'Invalid session' }, 401)

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return json({ error: 'Body must be multipart form data' }, 400)
  }

  const audio = form.get('audio')
  if (!(audio instanceof File) || audio.size === 0) return json({ error: 'No recording received' }, 400)
  if (audio.size > MAX_BYTES) return json({ error: 'That recording is too long to transcribe in one go.' }, 413)

  const language = form.get('language') === 'pt' ? 'pt' : 'en'
  const vocabulary = String(form.get('vocabulary') ?? '').slice(0, 800).trim()

  let reason = ''
  for (const model of MODELS) {
    const upstream = new FormData()
    upstream.append('file', audio, audio.name || 'dictation.webm')
    upstream.append('model', model)
    upstream.append('language', language)
    if (vocabulary) upstream.append('prompt', vocabulary)
    upstream.append('response_format', 'json')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    })

    if (res.ok) {
      const data = await res.json()
      const text = String(data.text ?? '').trim()
      // The hint read back, or a known phantom, means nobody said anything.
      const echo = vocabulary && squash(text).length > 0 && squash(vocabulary).includes(squash(text))
      // Short only: a long dictation that happens to mention one is real.
      if (echo || (text.length < 80 && PHANTOMS.test(text))) return json({ text: '' })
      return json({ text })
    }

    const raw = await res.text()
    console.error(`[transcribe] ${model} failed (${res.status}):`, raw)
    // OpenAI's own words, so the person at the mic sees what actually went
    // wrong — a key without audio permission, no credit, a file it refused —
    // rather than a shrug. Its messages never contain the key itself.
    let message = raw
    try {
      message = JSON.parse(raw)?.error?.message ?? raw
    } catch { /* not JSON: keep the text */ }
    reason = `${model} → ${res.status}: ${message}`.slice(0, 300)
    // A bad key or no credit fails the same way on every model.
    if (res.status === 401 || res.status === 429) break
  }

  return json({ error: reason || 'Could not transcribe that recording.' }, 502)
})
