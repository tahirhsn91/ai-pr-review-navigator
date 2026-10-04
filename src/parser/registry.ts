import { extname } from "node:path";

import type { LanguageSyntaxParser, ParserRegistry } from "./types.js";

export function createParserRegistry(): ParserRegistry {
  const parsers: LanguageSyntaxParser[] = [];
  return {
    register(parser) {
      parsers.push(parser);
    },
    resolve(path) {
      const extension = extname(path).toLowerCase();
      for (const parser of parsers) {
        const language = parser.extensions[extension];
        if (language !== undefined) {
          return { parser, language };
        }
      }
      return undefined;
    },
  };
}
