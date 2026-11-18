const {StringDecoder} = require('node:string_decoder');

const spinner = /^\s*[⠁-⣿|/\\-]\s*(Starting up(?:\.\.\.|…)|Connected)\s*$/i;
const lineLimit = 16384;

// Each pipe needs its own parser because even a UTF-8 character or escape
// sequence can be split across reads.
class OutputFilter {
  constructor(emit) {
    this.emit = emit;
    this.decoder = new StringDecoder('utf8');
    this.state = 'text';
    this.csiParameter = '';
    this.line = '';
    this.carriageReturn = false;
  }

  write(chunk) {
    this.consume(this.decoder.write(chunk));
  }

  end() {
    this.consume(this.decoder.end());
    this.flush(false);
  }

  flush(newline) {
    const line = this.line;
    this.line = '';
    if (!spinner.test(line) && (line || newline)) {
      this.emit(line + (newline ? '\n' : ''));
    }
  }

  consume(text) {
    for (const char of text) {
      switch (this.state) {
        case 'escape':
          if (char === '[') {
            this.state = 'csi';
            this.csiParameter = '';
          }
          else if (']PX^_'.includes(char)) this.state = 'string';
          else this.state = char >= ' ' && char <= '/' ? 'escape' : 'text';
          continue;
        case 'csi':
          if (char >= '@' && char <= '~') {
            if (char === 'K' && this.csiParameter === '2') this.line = '';
            this.state = 'text';
          } else if (this.csiParameter.length < 2) {
            this.csiParameter += char;
          }
          continue;
        case 'string':
          if (char === '\x1b') this.state = 'string-end';
          else if (char === '\x07' || char === '\x9c') this.state = 'text';
          continue;
        case 'string-end':
          this.state = char === '\\' ? 'text' : 'string';
          continue;
      }
      if (char === '\x1b' || char === '\x9b') {
        this.state = char === '\x1b' ? 'escape' : 'csi';
        this.csiParameter = '';
      } else if (char === '\r') {
        this.carriageReturn = true;
      } else if (char === '\n') {
        this.flush(true);
        this.carriageReturn = false;
      } else if (char === '\t' || !/[\x00-\x1f\x7f-\x9f]/.test(char)) {
        if (this.carriageReturn) {
          this.line = '';
          this.carriageReturn = false;
        }
        this.line += char;
        if (this.line.length >= lineLimit) this.flush(false);
      }
    }
  }
}

module.exports = {OutputFilter};
