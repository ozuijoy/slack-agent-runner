// Files under ui/ are imported as text (the "rules" entry in wrangler.jsonc) and served by
// src/ui-routes.ts behind Cloudflare Access.
declare module '*.html' {
  const text: string
  export default text
}
declare module '*.css' {
  const text: string
  export default text
}
declare module '*/ui/app.js' {
  const text: string
  export default text
}
declare module '*/ui/transcript.js' {
  const text: string
  export default text
}
