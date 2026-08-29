export class ResilientTts {
  #primary;
  #fallback;

  constructor({primary, fallback} = {}) {
    if (!primary || typeof primary.synthesize !== 'function') {
      throw new TypeError('primary must provide synthesize()');
    }
    if (!fallback || typeof fallback.synthesize !== 'function') {
      throw new TypeError('fallback must provide synthesize()');
    }
    this.#primary = primary;
    this.#fallback = fallback;
  }

  getVoiceSettings() {
    if (typeof this.#primary.getVoiceSettings !== 'function') {
      throw new Error('Primary speech synthesizer does not expose voice settings');
    }
    return this.#primary.getVoiceSettings();
  }

  updateVoiceSettings(settings) {
    if (typeof this.#primary.updateVoiceSettings !== 'function') {
      throw new Error('Primary speech synthesizer does not support voice setting updates');
    }
    return this.#primary.updateVoiceSettings(settings);
  }

  async synthesize(text, {signal} = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await this.#primary.synthesize(text, {signal});
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    signal?.throwIfAborted();
    try {
      return await this.#fallback.synthesize(text, {signal});
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AggregateError([lastError, error],
        'Primary and fallback speech synthesis failed');
    }
  }
}
