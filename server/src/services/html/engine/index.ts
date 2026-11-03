/** Engine Video HTML (W1a): head do server chèn, materialize, lint, trình duyệt dựng, runner. Xem docs trong PLAN-html-video.md. */
export { HTML_BASE_CANVAS, HTML_CSP, outputResolutionOf, HTML_FONT_FAMILY, HTML_FONT_FILES, htmlRuntimeDir, runtimeFileMap, injectHead, type InjectOptions } from './head.js';
export { materialize, type MaterializeOptions } from './materialize.js';
export { lintComposition, installHtmlValidator } from './lint.js';
export { securityLint, securityLintFile, badUrl, type SrcFile } from './security-lint.js';
export { BROWSER_PIN, type BrowserPin, rendererStatus, browserPath, startRendererDownload, cancelRendererDownload, downloadBrowser, installedBrowser, RENDERER_MISSING_MSG, type HtmlRendererStatus } from './browser.js';
export { runRender, captureFrames, runnerEnv, runnerCommand, type RenderOptions, type CaptureOptions } from './runner.js';
