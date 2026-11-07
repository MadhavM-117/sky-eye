# Config

- `.sky-watch/config.json` loaders are per-concern, not one shared loader:
  `chunker.loadConfig` (review sizes), `custom-classifier.loadClassifierConfig`
  (`classifier` key) and `loadClassifyRules` (`classifyRules` key). The
  classifier module owns its keys so the chunker stays about chunking — add
  new config keys next to the module that consumes them.
