# KaTeX assets (v0.16.47)

Copied from `node_modules/katex/dist` (MIT License, see `LICENSE`) for the Markdown
preview. The preview runs in a sandboxed iframe that only allows `data:` fonts, so
`src/lib/markdown_render.ts` fetches this stylesheet and inlines the `.woff2` fonts.

Update after upgrading `katex`:

```shell
cp node_modules/katex/dist/katex.min.css public/vendor/katex/
cp node_modules/katex/dist/fonts/*.woff2 public/vendor/katex/fonts/
```
