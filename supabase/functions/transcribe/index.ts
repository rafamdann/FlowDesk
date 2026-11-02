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

// A nudge towards the vocabulary of the work, which is what a generic model
// gets wrong: client names, platforms, the jargon of social media.
const PROMPTS: Record<string, string> = {
  en: 'FlowDesk notes, tasks and work log entries for a social media agency: posts, reels, stories, ads, campaigns, clients.',
  pt: 'Notas, tarefas e registos de trabalho do FlowDesk para uma agência de redes sociais: publicações, reels, stories, anúncios, campanhas, clientes.',
}

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

  let reason = ''
  for (const model of MODELS) {
    const upstream = new FormData()
    upstream.append('file', audio, audio.name || 'dictation.webm')
    upstream.append('model', model)
    upstream.append('language', language)
    upstream.append('prompt', PROMPTS[language])
    upstream.append('response_format', 'json')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    })

    if (res.ok) {
      const data = await res.json()
      return json({ text: String(data.text ?? '').trim() })
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
