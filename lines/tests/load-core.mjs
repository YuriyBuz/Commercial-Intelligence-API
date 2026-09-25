/* Завантаження assets/core.js у тестах Node.
 *
 * Чому не require(): lines/package.json має "type": "module", тож Node вважає
 * assets/core.js ES-модулем, і require()/import не віддадуть module.exports
 * (у ESM змінної `module` немає). Сам core.js — класичний скрипт (його ж вставляють
 * як Core.gs в Apps Script), тому виконуємо його як CommonJS-завантажувач:
 * обгортка (module, exports) + vm.runInThisContext у ПОТОЧНОМУ realm — Date, Array,
 * Set з ядра ті самі класи, що й у тестах (важливо для assert.deepStrictEqual).
 * Обгортка стоїть у першому рядку, тож номери рядків у стек-трейсах збігаються з файлом.
 *
 *   import LinesCore from './load-core.mjs';            // готовий екземпляр
 *   import { loadCore } from './load-core.mjs';         // новий екземпляр
 *   import { loadCoreAsGlobalScript } from './load-core.mjs'; // як у GAS: глобальний var
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const CORE_PATH = fileURLToPath(new URL('../assets/core.js', import.meta.url));

export function coreSource() {
  return readFileSync(CORE_PATH, 'utf8');
}

export function loadCore() {
  const module = { exports: {} };
  const fn = vm.runInThisContext('(function (module, exports) {' + coreSource() + '\n})', { filename: CORE_PATH });
  fn(module, module.exports);
  return module.exports;
}

/* Виконує core.js як глобальний скрипт в окремому vm-контексті без `module`
 * (так його бачить Google Apps Script: усі .gs файли — одна глобальна область).
 * Повертає контекст; ядро доступне як ctx.LinesCore. */
export function loadCoreAsGlobalScript(globals = {}, filename = 'Core.gs') {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(coreSource(), ctx, { filename });
  return ctx;
}

const LinesCore = loadCore();
export { LinesCore };
export default LinesCore;
