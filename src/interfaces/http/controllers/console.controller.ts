import { readFileSync } from 'node:fs';
import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../guards/provider-auth.guard.ts';

export const CONSOLE_HTML_PATH = new URL('../../../../docs/console/index.html', import.meta.url);

let cachedHtml: string | undefined;

@Public()
@Controller('console')
export class ConsoleController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  show(): string {
    cachedHtml ??= readFileSync(CONSOLE_HTML_PATH, 'utf8');
    return cachedHtml;
  }
}
