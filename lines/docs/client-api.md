# FOODLINE · Лінії — клієнтський API (довідник для розробників екранів)

Цей документ — точний контракт глобальних обʼєктів, які надає основа веб-клієнта
(`index.html`, `assets/styles.css`, `ui.js`, `local-store.js`, `api.js`, `app.js`, `sw.js`).
Екрани оператора (`assets/operator.js` + `operator.css`) і керівництва (`assets/manager.js` +
`manager.css`) будуються ЛИШЕ через ці глобали. Бізнес-логіка — у `assets/core.js` (`LinesCore`,
див. SPEC §3 і тести ядра).

---

## 0. Загальні правила

* Порядок скриптів (`index.html`, усі з однаковою версією `?v=N`, зараз `?v=3`): `core.js` → `local-store.js` → `api.js` → `ui.js` →
  `app.js` → `operator.js` → `manager.js`. Стилі: `styles.css` → `operator.css` → `manager.css`.
* Збірки немає. Клієнтський код — ES2017 (`const`/`let`, стрілки, шаблонні рядки дозволені;
  **без** `?.`, `??`, `import/export`). Кожен файл — IIFE або один глобал.
* `App` стартує на `DOMContentLoaded`, тобто ПІСЛЯ виконання `operator.js`/`manager.js`:
  реєструйте маршрути на верхньому рівні файлу (`App.route(...)`).
* Увесь текст для людей — українською. Будь-який динамічний рядок у HTML — через `UI.esc()`
  або `UI.html```.
* Час у даних (`App.state`, відповіді `Api`) — **ISO-рядки** (UTC). Для показу — `UI.fmt.*`
  (пояс заводу `settings.tz`), для обчислень — `UI.toDate(v)` / `Date.parse(v)`. Поточний час —
  **`App.now()`** (з поправкою на годинник сервера), не `new Date()`.
* Записи оператора — лише `Api.write(...)` (черга, офлайн). Дії керівника — `Api.call(...)` (онлайн).

---

## 1. Маршрути й екрани — `App`

### 1.1 Реєстрація

```js
App.route(pattern, handler, opts?)
```

* `pattern` — шлях хеша без `#`: `'/line/:id'`, `'/line/:id/check/:occasion'`, `'/m/:view'`.
  Параметри `:name` → `params.name` (декодовані). Шаблон з меншою кількістю параметрів
  важливіший (`'/m/equipment'` переможе `'/m/:view'`). Повторна реєстрація того самого шаблону
  **замінює** попередню.
* Query хеша: `#/line/L1/work?rule=R5&type=to` → `params.rule`, `params.type`
  (параметри шляху мають пріоритет над query).
* `handler(params, host, ctx)`:
  * `host` — **новий порожній `<div class="page">` при кожному показі** (у `<main id="view">`).
    Вішайте обробники подій прямо на `host` — вони зникнуть разом зі старим екраном.
  * `ctx = {hash, path, query, pattern, params, reason, host, alive()}`;
    `reason`: `'nav'` (перехід) | `'boot'` (перемальовування після нових даних) | `'refresh'` | `'route'`;
    `ctx.alive()` → `false`, щойно показано інший екран (перевіряйте після `await`).
  * Може повернути нічого, контролер або `Promise` контролера:
    `{ onBoot(state, meta)?, onQueue(netInfo)?, dispose()? }`.
* `opts`: `{ boot: false }` — не чекати даних (`App.state` може бути `null`);
  `{ rerender: false }` — ніколи не перемальовувати автоматично; `{ title: 'Текст' }` — заголовок вкладки.
* Поки немає даних (перший запуск, дані ще вантажаться) обробник НЕ викликається — App показує
  індикатор або екран помилки; обробник буде викликано, щойно дані надійдуть.
* Без налаштувань пристрою будь-який шлях перенаправляється на `#/setup`.

### 1.2 Автоматичне оновлення екрана

Коли надходять нові дані (опитування кожні `settings.refresh_sec` с, підтвердження записів,
`App.refresh()`), або змінюється кількість записів у черзі (оптимістичний стан):

1. є `ctrl.onQueue` (лише зміни черги) / `ctrl.onBoot` → викликається він, екран не перемальовується;
2. інакше, якщо екран **не брудний** і не `rerender:false` — обробник викликається знову
   (`reason:'boot'`, прокрутка зберігається). Під відкритим модальним вікном перемальовування
   відкладається до його закриття.

«Брудний» екран (форма в процесі): `App.setDirty(true)` / `App.setDirty(false)`, `App.isDirty()`.
Будь-який `input`/`change` усередині елемента з атрибутом **`data-track-dirty`** позначає екран
брудним автоматично. Для брудного екрана: без автооновлення; посилання / кнопка «Назад» («Вперед») браузера
питають «Покинути екран?»; закриття вкладки — стандартне попередження. Перехід при цьому скасовується
зворотним кроком історії (записи історії не переписуються): «Залишитися» — історія та сама, що й до
натискання; «Покинути» — той самий крок повторюється. `App.go()` завжди переходить і скидає «брудність»
(викликайте після збереження).

Кожен запис історії позначено номером (`history.state.fl`) — так роутер відрізняє «назад», «вперед» і
новий перехід. Не перезаписуйте `history.state` власними об’єктами (лише `history.replaceState(history.state, '', hash)`).

Захист від подвійного дотику: коли відкривається вікно (`UI.modal` і все на ньому) або новий екран,
другий дотик подвійного тапу, що влучає в нове під пальцем (≤450 мс, ≤64 px від першого; миша — друге
клацання подвійного), ігнорується (`UI.armTapGuard()` — увімкнути вручну, напр. після перемальовування
екрана власною дією).

### 1.3 Навігація

| Виклик | Дія |
|---|---|
| `App.go('#/line/L1')`, `App.go('/line/L1', {replace:true})` | перехід (replace — без нового запису історії) |
| `App.back(fallback='#/')` | назад у межах застосунку, інакше `go(fallback,{replace:true})` |
| `App.backTo(hash)` | назад, якщо попередній запис історії — саме `hash`; інакше `go(hash,{replace:true})` (напр. повернення на екран лінії після збереження) |
| `App.prevHash()` | хеш попереднього запису історії цього сеансу або `''` |
| `<a href="#/…" data-back>` | глобально: клік = `App.back(href)` (кнопка «Назад» у `UI.pageHead`) |
| `App.rerender()` | перемалювати поточний екран |
| `App.current()` | `ctx` поточного показу або `null` |
| `App.currentLineId()` | `id` із `/line/:id…` або `?line=` поточного маршруту, інакше `''` |
| `App.setTitle('Лінія №1')` | `document.title = 'Лінія №1 · Foodline · Лінії'` |

### 1.4 Маршрути

| Хеш | Файл | Опис |
|---|---|---|
| `#/` | app.js | Лінії (плитки). Закріплений планшет при старті відкриває `#/line/<pinned>` |
| `#/setup` | app.js | майстер налаштування пристрою (`boot:false`). На вже налаштованому пристрої — лише з PIN керівника (без зв’язку / з невірним токеном — «Змінити без входу»); чинний токен майстер не показує: поле порожнє = «залишити поточний»; тестову адресу Apps Script (`…/dev`) не приймає — потрібна `/exec` |
| `#/device` | app.js | налаштування пристрою, черга, «Скинути демо-дані» (`boot:false`) |
| `#/line/:id` | operator.js | екран лінії: стан, дії, ТО і ППР лінії, стрічка «сьогодні» |
| `#/line/:id/check/:occasion` | operator.js | чек-лист `start` \| `changeover` \| `end` (`?then=none` — без зміни стану) |
| `#/line/:id/work` | operator.js | запис роботи: `?rule=R5&type=to&unit=U1&mode=repair\|maint\|rule\|clean\|setup` |
| `#/line/:id/history` | operator.js | історія лінії за 14 днів |
| `#/m` | manager.js | вхід у розділ керівництва → `#/m/overview` |
| `#/m/:view` | manager.js | розділи (нижче); невідомий id → `#/m/overview`. Головний екран посилається на `#/m/equipment`, коли ліній немає |
| `#/m/equipment/:line` | manager.js | лінія в «Обладнанні»: `?tab=units\|items\|meters\|rules` |

Розділи керівництва (`#/m/<id>`, **канонічні id**; у посиланнях використовуйте саме їх):

| id | Розділ | Query |
|---|---|---|
| `overview` | Огляд: KPI, стан ліній, матриця чек-листів, години за станами, причини простоїв, звіт по роботах і агрегатах, CSV | `days=7\|14\|30\|62` або `from`/`to=YYYY-MM-DD` (свій період, ≤ 62 дні, не пізніше сьогодні) |
| `maintenance` | ТО і ППР (псевдоніми **`maint`**, `plan` — лише для сумісності) | `tab=due\|plan\|year`, `status=due\|soon\|ok\|none`, `line=<id>` |
| `journal` | Журнал (псевдонім `history`) | `period=today\|7\|30\|90`, `from`/`to=YYYY-MM-DD`, `line`, `unit`, `types=events,checks,works,readings`, `work_type`, `q` |
| `checks` | Чек-листи | `line=<id>` |
| `equipment` | Обладнання | — |
| `staff` | Персонал | — |
| `settings` | Налаштування | — |

Приклад: KPI «Прострочено ТО» веде на `#/m/maintenance?tab=due&status=due`.

---

## 2. Дані — `App`

`App.state` — остання відповідь `bootstrap` (SPEC §3.5; кеш на пристрої для офлайн-старту):

```
{ ok, version, now, admin:false,
  settings: {company, tz, digest_hour, …, refresh_sec, stop_reasons:[…], products:[…], app_url},
  lines:[{id,name,kind,area,description,sort,active,created}],
  units:[{…, hours}], items:[{id,line_id,unit_id,occasions:['start',…],section,text,type,unit_label,
         min,max,target,options:[…],required,critical,hint,sort,active}],
  meters:[{…, value, value_ts, avg_per_day}], rules:[…без notify],
  staff:[{id,name,role,line_ids:[…],pin_hash|null,active,sort}],
  status:{[line_id]: статус (нижче)}, due:[due-обʼєкти], avg_h:{[line_id]:год/добу}, avg_meter:{[meter_id]:…} }
```

Не змінюйте `App.state` вручну. Довідники — лише активні записи (керівнику з повним переліком
потрібен `Api.call('bootstrap', {}, {admin:true})`).

| Виклик | Повертає |
|---|---|
| `App.state`, `App.idx` | дані; індекси `{line, unit, item, meter, rule, staff}` за id |
| `App.line(id)`, `unit(id)`, `item(id)`, `meter(id)`, `rule(id)`, `staff(id)` | запис або `null` |
| `App.lines()` | активні лінії (у порядку `sort`) |
| `App.unitsOf(lineId)`, `metersOf(lineId)`, `rulesOf(lineId)` | активні записи лінії |
| `App.itemsFor(lineId, occasion?)` | пункти чек-листа для `start`/`changeover`/`end` (як їх оцінює ядро: активні, агрегат активний) |
| `App.staffFor(lineId)` | персонал, допущений до лінії (`line_ids` порожній = усі) |
| `App.lineStatus(lineId)` | статус лінії **з оптимістичним накладанням черги** (нижче) |
| `App.dueFor(lineId)` | due-обʼєкти лінії з `state.due` (відсортовані: due, soon, ok, none) |
| `App.now()` | `Date` з поправкою годинника (= `Api.now()`). Моменти, запамʼятані як `Date.now()` пристрою (напр. `Api.net().boot_at`), для показу переводьте в час сервера: `+ Api.skew()` («дані на …» так і робить) |
| `App.liveTodayHours(status)` | години роботи за СЬОГОДНІ (день заводу): `today_h` + робота після моменту bootstrap; bootstrap учорашній (офлайн через північ) → рахується від півночі |
| `App.checkMissing(status)` | лінія працює без чек-листа запуску — одне правило для плитки, екрана лінії й таблиці керівника: `status.start_uncovered` (запуск ЦІЄЇ роботи позначено «без чек-листа» і відтоді чек-листа запуску не пройдено; пізній чек-лист закриває питання). Не за часом від `work_since`: запуск із чек-листом, що вже минув (довга підготовка, простій і відновлення), — не порушення; довга зміна — окремо `long_run`. Сервер старішої версії (без поля) — лише `flag` поточної події |
| `App.refresh()` | надіслати чергу + свіжий bootstrap → `Promise<відповідь>` |
| `App.mode()` | `'local'` \| `'remote'` \| `''` |

Статус лінії (`App.lineStatus`):

```
{ line_id, state, since /*ISO*/, product, operator, staff_id, event_id, reason, note, flag,
  cum_h /*мотогодини на момент as_of*/, starts, today_h, last_check:{id,ts,occasion,result}|null,
  start_check_valid /*є чек-лист запуску в межах checklist_valid_hours, новіший за останнє завершення роботи лінії*/,
  long_run /*робота (не «Не працює») триває ≥ long_run_hours*/, work_since /*ISO: початок поточної роботи (вихід із «Не працює»)*/,
  ran_since_off /*лінія була в «Працює» / «Простій» після останнього «Не працює»: наступне «Працює» — НЕ запуск*/,
  start_uncovered /*запуск поточної роботи — «без чек-листа», і чек-листа запуску відтоді не було (App.checkMissing)*/,
  as_of /*ISO: коли пораховано (boot.now)*/, pending /*к-сть неnадісланих операцій цієї лінії*/ }
```

`start_check_valid`: чек-лист запуску «витрачається» **завершенням роботи** — першим переходом у «Не працює» після
того, як лінія працювала («Працює» / «Простій») — нова зміна потребує нового чек-листа, навіть якщо
`checklist_valid_hours` ще не минули. Миття / налаштування / ТО без запуску → «Не працює» чек-лист не витрачають
(підготовка до роботи). `ran_since_off` потрібен клієнту, щоб так само вирішити для подій черги.

Накладання: кожна операція черги `event` змінює `state/since/product/operator/staff_id/reason/note/
event_id/flag/work_since/start_uncovered`; `checklist` — `last_check` (`result:null, pending:true`),
`start_check_valid=true` і `start_uncovered=false` для `start`, і `then_event` як подію. `flag:'no_checklist'` — як у ядрі, лише для
ЗАПУСКУ (перше «Працює» після «Не працює» без чинного чек-листа, коли `require_start_checklist`), а не для
повернення в роботу після налаштування / ремонту; подія черги, що переводить у «Не працює» лінію, яка працювала
(`ran_since_off`; напр., офлайн «Завершити роботу»), скидає `start_check_valid` у `false` (повторне «Не працює»
чи «Не працює» після миття / налаштування без запуску — ні); порядок черги (FIFO)
дає правильну відповідь і для «завершити → чек-лист запуску» в одній черзі. Після підтвердження сервер
повертає справжній `status`, і він одразу потрапляє в `App.state` (подія `boot`, `meta.source:'ack'`).

Due-обʼєкт (ядро): `{rule_id, line_id, unit_id, title, work_type, part, status:'due'|'soon'|'ok'|'none',
pct /*частка, 1 = 100 %*/, due_date, forecast, due_basis, ref_date, ref_hours, ref_meter, driver,
criteria:[{kind:'days'|'hours'|'meter', interval, used, left, pct, due_date, unit_label, forecast}],
summary /*«залишилось 5 дн. · 38 мотогод»*/, overdue_days, last_date, last_work_id}`.
`summary` для календаря — різниця **календарних днів** заводу («строк настав сьогодні», «прострочено на 1 дн.» —
уже наступного дня після строку). Перевищений інтервал за мотогодинами / лічильником: `due_date` — момент, коли поріг
справді перейшли (журнал стану / інтерполяція між двома показниками), `forecast:false`. Напрацювання лічильника
(`used`) ніколи не відʼємне: після показника з `reset` («лічильник скинуто / замінено») рахунок іде з нового числа
й додається до вже набраного; зниження без позначки (напр., внесене в таблиці) — нова база без приросту.

---

## 3. Люди: оператор і керівник — `App`

| Виклик | Опис |
|---|---|
| `App.operator()` | поточний оператор пристрою `{staff_id, name, role, since}` або `null` (спливає через 14 год) |
| `App.requireOperator(lineId)` | → `Promise<оператор|null>`. Якщо чинний і допущений до лінії — одразу; інакше вікно вибору (великі кнопки людей лінії, PIN-клавіатура для тих, у кого `pin_hash`, «Інша людина» — вільне імʼя, `staff_id:''`). `null` = скасовано — **нічого не записуйте** |
| `App.chooseOperator(lineId?)` | те саме вікно завжди (зміна оператора; є кнопка «Завершити зміну») |
| `App.signOut()` | завершити зміну (оператора не вибрано) |
| `App.requireAdmin(opts?)` | → `Promise<boolean>`: PIN керівника (клавіатура) → `Api.adminLogin` → запамʼятовується до закриття вкладки (sessionStorage). Демо-режим: PIN `1234` (підказка показується) |
| `App.isAdmin()` / `App.adminLogout()` | стан входу / вихід (з розділу `#/m…` — на `#/`) |

У запис передавайте `operator: op.name, staff_id: op.staff_id`.
Якщо ADMIN-дія отримала `ADMIN_REQUIRED` (PIN змінили), App сам просить PIN ще раз на `#/m…`.

---

## 4. `Api` — транспорт, черга, кеш

### 4.1 Виклик дії — `Api.call(action, params?, opts?)`

→ **`Promise<відповідь>`, який ніколи не відхиляється.** Успіх — відповідь ядра (`ok:true`, SPEC §3.4);
помилка — `{ok:false, error, message /*українською*/}`.

* `opts.admin: true` — додати PIN керівника (для ADMIN-дій — `ACTIONS[a].admin` — додається автоматично);
  `opts.timeout` (мс, типово 30000).
* Коди помилок сервера: `BAD_TOKEN`, `ADMIN_REQUIRED`, `BAD_REQUEST`, `NOT_FOUND`, `UNKNOWN_ACTION`,
  `LOCKED`, `SERVER_ERROR`, `RATE_LIMIT`. Клієнтські (`client:true`): `NETWORK` (немає звʼязку),
  `TIMEOUT`, `BAD_RESPONSE` (не JSON / HTML-сторінка), `NOT_CONFIGURED`, `TOO_LARGE` (запит задовгий для JSONP,
  а POST теж не пройшов), `STORAGE_FULL` (лише `Api.write`: сховище пристрою переповнене).
* Транспорт (віддалений режим): `POST` `text/plain;charset=utf-8` з тілом `{...params, action, token, device, admin?}`
  (без CORS-preflight). Якщо POST падає з `TypeError`, а JSONP-`ping` працює — запити йдуть JSONP GET
  `?action=…&token=…&payload=<JSON>&callback=…` (запит повторюється автоматично, крім `save` без `row.id`).
  Резервний канал не назавжди: у фоні (після перезавантаження — одразу, далі раз на `postReprobeMs`, 5 хв; на
  «Надіслати зараз», коли є відкладені записи, — раз на `postReprobeForceMs`) POST перевіряється `ping`-ом і,
  якщо працює, стає основним знову. Запит, задовгий для адреси JSONP, спершу пробується через POST.
  Демо-режим: `LocalBackend.handle(req)`.
* Поправка годинника: `skew = server.now − середина запиту`, точність ±RTT/2. Годяться й повільні відповіді
  (RTT до `skewMaxRtt`, 30 с); зберігається найточніший замір `{skew, rtt, at}` (`'fl_lines_skew'`), новий
  береться, коли він точніший, старий застарів (`skewStaleMs`, 6 год) або з ним не узгоджується (годинник
  перевели). Поки поправки немає (або вона давня), перед надсиланням черги йде `ping`. Записи, яким `Api.write`
  поставив час сам (`op.auto_ts`), після зміни поправки на ≥`restampMs` (1 хв) отримують виправлений `ts`
  (час, введений людиною, не змінюється).

Корисні дії для екранів (відповіді — SPEC §3.4 + нотатки ядра):
`line {line_id, days≤62}` → `{events, checks, works, readings, timeline:[{state,from,to,hours,product,reason}], days:[{day, hours:{state:h}, starts, checks}]}`;
`check_detail {id, ts?}` → `{check, answers}`; `history {from?, to?, line_id?, unit_id?, types?, work_type?, q?, limit?, include_void?}`;
`dashboard {days?, from?, to?}` (`days` 1–62, типово 14 — останні дні до сьогодні; або минулий період `from`/`to` = `YYYY-MM-DD`:
не довше 62 днів — довший обрізається до 62 днів, що закінчуються в `to`; `to` не пізніше сьогодні; недійсні дати ігноруються.
Відповідь має `from`, `to` — межі періоду; клієнт, що не бачить їх у відповіді, має справу зі старим сервером; `status` і `due` —
завжди «зараз»); `plan {from?, to?}`; ADMIN: `save {table,row}`, `remove`, `void {table,id,note,ts?}` (передавайте `ts`
запису — сервер знайде його вікном навколо цього часу, а не читанням усього журналу),
`settings_save {values}`, `digest_preview`, `notices {limit}`, `recompute`, `bootstrap` з `{admin:true}`
(неактивні записи, `manager_emails`, `config_issues`: `[{table, sheet, id, name, problem: 'no_id'|'duplicate'|'bad_pin'|'no_occasion'}]`).
`save` приймає рядок, доданий у таблиці з ID не за шаблоном (кирилиця, пробіл), — він редагується як є; НОВИЙ ID — лише
`[A-Za-z0-9_.:-]`. `notices` → `{notices:[{id, ts, kind, key, to, subject, status:'sent'|'error'|'preview', error}]}`
(в аркуші «Сповіщення» статус — українською: «Надіслано», «Помилка», «Демо: не надсилалося»).
Для `save` НОВОГО рядка передавайте `row.id = Api.newId()` — тоді повтор запиту не створить дубль.

Відповіді «Н/З» (не застосовується) рахуються окремо:
* рядок чек-листа (`checks` у `line`, `history`, `check_detail`): `{id, ts, started, line_id, occasion, operator, staff_id, product,
  result:'ok'|'remarks'|'fail', total, failed, out_of_range, missing, na /*к-сть відповідей «Н/З»; стовпець аркуша «Н/З»*/,
  comment, device, created, void, void_note}`;
* `dashboard` → `compliance[line_id][]` (дні): `{day, status, starts, covered, run_h, uncovered, forced, long_runs,
  checks:[{id, ts, occasion, result, na}]}`; `long_runs` — робіт, що почалися цього дня й тривали (чи ще тривають)
  довше за `long_run_hours` без завершення (лише зміни, у яких лінія працювала); разом з `uncovered > 0` дають `status:'miss'`;
* `dashboard` → `stats[line_id]`: `{…, checks, checks_ok, checks_remarks, checks_fail, out_of_range, checks_na}`.

### 4.2 Запис оператора — `Api.write(action, params, opts?)`

`action` ∈ `event | checklist | work | reading` (інші → `{ok:false,error:'BAD_REQUEST'}`).
Задає `params.id = Api.newId()` і `params.ts = Api.now().toISOString()`, якщо їх немає;
для `checklist` з `then_event` без `id` — `then_event.id = id + '-e'`. Операція потрапляє в постійну
чергу (`localStorage 'fl_lines_queue'`), надсилання починається одразу. → `Promise`:

| Результат | Значення |
|---|---|
| `{ok:true, queued:false, op, data}` | сервер підтвердив за `opts.wait` мс (типово 4000); `data` — відповідь дії (`{ok, event, status}` тощо); `data.duplicate:true` — повтор уже збереженого |
| `{ok:true, queued:true, op}` | збережено в черзі (офлайн / сервер зайнятий / пауза) — надішлеться сам |
| `{ok:false, rejected:true, op, error, message}` | сервер відхилив остаточно (`BAD_REQUEST`, `NOT_FOUND`…): запис у списку відхилених |
| `{ok:false, queued:true, error:'STORAGE_FULL', op, message}` | сховище пристрою переповнене (навіть після звільнення кешу bootstrap і залишків демо-даних): запис лише в пам’яті вкладки й надішлеться, поки застосунок відкритий; `Api.net().storage_full`, подія `error`, банер і тост від App |

`op = {op_id, action, params, target, queued_at, tries, last_error, line_id}`.
`Api.write` НЕ перевіряє дані: валідуйте форму до запису (обовʼязкові поля, `ts` не старший за 45 днів
для подій/чек-листів/показників, 366 — для робіт).

Приклади:

```js
const op = await App.requireOperator(lineId); if (!op) return;
// зміна стану
Api.write('event', { line_id, state: 'stop', reason: 'Перерва', note, operator: op.name, staff_id: op.staff_id });
// чек-лист запуску → Працює (started — коли відкрили екран); readings — лічильники при завершенні
Api.write('checklist', { line_id, occasion: 'start', started, operator: op.name, staff_id: op.staff_id, product, comment,
  answers: [{ item_id, value: 'ok'|'fail'|'na'|'12,5'|'текст'|'варіант', note }],
  then_event: { state: 'run', product }, readings: [{ meter_id, value, mode }], forced: false });
// робота (ТО за регламентом; meter_value — показник лічильника правила; meter_reset — лічильник скинуто / замінено)
Api.write('work', { line_id, unit_id, work_type: 'to', rule_id, title, description, parts, performer: op.name,
  staff_id: op.staff_id, started, duration_min, downtime_min, status: 'done', meter_value, meter_reset });
Api.write('reading', { meter_id, value: 1200, mode: 'inc', operator: op.name, note });
Api.write('reading', { meter_id, value: 15, mode: 'abs', reset: true, operator: op.name });   // новий відлік
```

Накопичувальний (`abs`) показник, менший за попередній, сервер приймає лише з `reset:true` (`reading`, `readings[].reset`
у чек-листі) / `meter_reset:true` (`work`); інакше `reading` / `work` → `BAD_REQUEST` («… менший за попередній …»), а в
чек-листі показник пропускається (`readings_skipped:[{meter_id, value, reason:'lower', prev, message}]`, чек-лист
зберігається). Перевіряйте це до запису (`Operator` питає «Виправити число» / «Лічильник скинуто / замінено»).

### 4.3 Черга

* Надсилання FIFO пакетами `batch` ≤ 20 операцій (для JSONP — ще й за довжиною адреси);
  результат кожної: `ok`/`duplicate` → видаляється; `BAD_REQUEST|NOT_FOUND|UNKNOWN_ACTION|ADMIN_REQUIRED` →
  у відхилені (`'fl_lines_rejected'`, подія `error`); `LOCKED|SERVER_ERROR|RATE_LIMIT|NETWORK|TIMEOUT|BAD_RESPONSE` →
  лишається, повтор через 5, 15, 30, 60, 120 с; також одразу на `online`, фокус вікна, повернення вкладки,
  новий запис. `BAD_TOKEN` → пауза (банер «Невірний токен»), до зміни токена / успішного запиту / `Api.resume()`.
  `TOO_LARGE` (запис не вміщується в адресу JSONP, а POST не працює) → запис **відкладено**: лишається в черзі
  з поясненням, поки канал JSONP його пропускають (решта черги йде далі), і він надсилається, щойно POST
  запрацює. Запис, що не надсилається (відкладений або ≥3 невдалих спроб), можна видалити у вікні
  «Синхронізація».
* Кожна операція привʼязана до підключення (`target`: `'local'` або `'remote:<endpoint>'`); операції
  іншого підключення не надсилаються (їх видно в черзі, можна видалити).

| Виклик | Опис |
|---|---|
| `Api.flush(force?)` | надіслати зараз (`true` — ігнорувати паузу між повторами) → `Promise<netInfo>`. Виклик під час активного надсилання запамʼятовується: одразу після нього йде ще один прохід (запис, доданий «на хвості» попереднього пакета, не чекає страховочного таймера), а повернений `Promise` завершується вже після цього проходу |
| `Api.queue()` | операції поточного підключення (копії, FIFO) |
| `Api.pendingFor(lineId)` | операції черги лінії — показуйте їх в історії як «очікує синхронізації» |
| `Api.allQueued()` | усі операції (+ `other_target:true` для чужих) |
| `Api.rejected()` | відхилені (`{…op, error, message, rejected_at}`) |
| `Api.retryRejected(opId|'all')`, `Api.discardRejected(opId|'all')`, `Api.discardQueued(opId|'other')` | керування |
| `Api.resume()` | зняти паузу й надіслати |
| `App.describeOp(op)` | `{title, sub}` українською для списків (напр. «Стан лінії → Простій (Перерва)») |
| `App.showQueue()` | вікно «Синхронізація» (те саме, що клік по індикатору мережі) |

### 4.4 Кеш bootstrap і стан мережі

| Виклик | Опис |
|---|---|
| `Api.boot()` | свіжий bootstrap → `Promise<відповідь>`; успіх оновлює кеш (`'fl_lines_boot'`) і генерує `boot`. Якщо під час запиту прийшло підтвердження запису, одразу після нього йде ще один запит; а в застарілу відповідь повертаються стан лінії, строк ТО й лічильник із таких підтверджень |
| `Api.cachedBoot()` | кешовані дані поточного підключення або `null` (синхронно) |
| `Api.primeBoot(data)` | підкласти дані як кеш (використовує майстер) |
| `Api.lineStatus(lineId, boot?)`, `Api.dueFor(lineId, boot?)` | як `App.lineStatus/dueFor` |
| `Api.net()` | `{mode, online:true|false|null, transport:'post'|'jsonp'|'local', paused:{code,message}|null, pending, pending_other, rejected, flushing, next_retry_at, last_ok_at, last_error:{error,message,at}|null, boot_at, skew_ms, skew_known /*чи був замір*/, skew_rtt, storage_full}` |
| `Api.now()`, `Api.skew()`, `Api.newId()` | час із поправкою; поправка, мс; новий id (12 символів base36) |
| `Api.config()` / `Api.saveConfig(patch)` | налаштування пристрою `{mode:'local'|'remote'|'', endpoint, token, device, pinned_line, theme:'dark'|'light', operator}` (`'fl_lines_v1'`) |
| `Api.adminLogin(pin)` → `Promise<відповідь>`, `Api.adminLogout()`, `Api.isAdmin()` | PIN керівника (sessionStorage `'fl_lines_admin'`) |
| `Api.testConnection(endpoint, token)` | перевірка без збереження → `{ok, transport, version, company, boot}` або помилка (адреса `/dev` → `BAD_REQUEST` одразу) |
| `Api.isDevUrl(url)` | чи це тестове розгортання Apps Script (`https://script.google.com/…/dev`): воно відповідає лише редакторам проєкту, анонімний планшет отримує сторінку входу Google. Майстер таку адресу не приймає, «Пристрій» показує попередження, а помилки зв’язку для неї пояснюють причину |
| `Api.isRead(action)`, `Api.target()` | чи READ-дія; ключ поточного підключення |
| `Api.options` | `{timeout, writeWait, batchMax, backoff:[с…], jsonpMaxUrl, skewMaxRtt, skewStaleMs, restampMs, probeTimeout, ackKeepMs, postReprobeMs, postReprobeForceMs}` — для тестів |

Події `Api.on(name, fn)` (повертає функцію відписки; `Api.off(name, fn)`):
`boot (data, {source:'server'|'ack'|'prime', at})`, `queue (netInfo)`, `net (netInfo)`,
`ack ({op, data})`, `error ({op, error, message, rejected:true})`, `admin ({admin}|{required:true})`, `config (cfg)`.

---

## 5. Демо-режим — `LocalBackend`, `LocalStore`

* `LocalStore` — `LinesCore.MemoryStore`, збережений у `localStorage 'fl_lines_demo_v1'` (запис із затримкою
  400 мс і при `pagehide`; при переповненні — видаляє найстаріші рядки журналів).
* `LocalBackend.init()` → `Promise<{seeded, summary}>` (засіває `LinesCore.seedDemo` з `now` = зараз, якщо порожньо);
  `LocalBackend.handle(req)` → `Promise<відповідь ядра>` (`req.admin === '1234'` → керівник; `_notify` → журнал
  «Сповіщення» зі статусом `preview`); `LocalBackend.resetDemo()` → `Promise<summary>`;
  `LocalBackend.info()` → `{ready, admin_pin, key, created, saved, size, error}`; `LocalBackend.ADMIN_PIN = '1234'`;
  `LocalBackend.store`, `LocalBackend.app` (ядро — лише для діагностики).
* Контракт сховища ядра (`LinesCore.createApp(store)`; так само `SheetStore` у `Server.gs`): `all(t)`, `since(t, date)`,
  `insert(t, rows)`, `update(t, patches)`, `replace(t, rows)`, `lock(fn)` і **необовʼязковий** `findBy(t, col, value)` →
  сирі рядки, де стовпець `col` дорівнює `value` (зайві рядки дозволені — ядро фільтрує; `null` = не підтримується, тоді
  ядро читає вікно журналу або весь журнал). `MemoryStore` і `LocalStore` його мають.
* Екрани не звертаються до `LocalBackend` напряму — лише через `Api` (однаково для обох режимів).
  Виняток — кнопка «Скинути демо-дані» в налаштуваннях (manager може показати її ж: `App.mode()==='local'`,
  `LocalBackend.resetDemo().then(() => App.refresh())`).

---

## 6. `UI` — помічники (ui.js)

**HTML-рядок** повертають: `icon, statusPill, timer, badge, progress, bigButton, tile, pageHead, chips, segmented,
field*, emptyState, spinner, kv, bars, stackBar, stateBar, legend, stateLegend, html`.
**Елемент / контролер / Promise** повертають: `el, modal, confirm, alert, prompt, choose, keypad, toast, menu, table`.

### 6.1 Базові

| Виклик | Опис |
|---|---|
| `UI.esc(s)` | HTML-екранування |
| ``UI.html`<b>${x}</b>` `` | шаблон з екрануванням значень; масиви зʼєднуються; `UI.raw(str)` — вставити готовий HTML (напр. вихід компонентів) |
| `UI.attrs({a:1, disabled:true})` | рядок атрибутів |
| `UI.el(tag, props, ...children)` | елемент; `props`: `class, text, html, style (рядок|обʼєкт), dataset, on:{click:fn}`, решта — атрибути |
| `UI.qs(sel, root?)`, `UI.qsa(sel, root?)` | пошук (qsa → масив) |
| `UI.delegate(root, 'click', selector, fn(e, el))` | делегування, → відписка |
| `UI.uid(prefix)`, `UI.num(v)` (рядок «12,5» → 12.5 \| null), `UI.toDate(v)` (Date\|ISO\|'DD.MM.YYYY'\|ms → Date\|null) | |
| `UI.now()` | «зараз» для таймерів (App підставляє `Api.now`) |

### 6.2 Форматування `UI.fmt` (пояс заводу з `settings.tz`)

`date(d)` 25.09.2026 · `dateShort` 25.09 · `dateLong` 25 вересня 2026 · `time` 14:05 · `datetime` 25.09.2026 14:05 ·
`dt(d)` розумно (сьогодні → 14:05; цей рік → 25.09 14:05) · `weekday` пт · `dayMonth` 25 вер · `dayLabel('2026-09-25')` пт 25.09 ·
`dayKey(d)` 'YYYY-MM-DD' · `monthName(9)` вересень · `relative(d)` «щойно», «5 хв тому», «сьогодні о 14:05», «вчора о 09:10», «через 3 дн.» ·
`duration(ms)` «3 год 12 хв», «45 хв», «<1 хв», «2 дн. 3 год» (`{seconds:true}` → «40 с») · `clock(ms)` 03:12:45 ·
`hm(hours)` «3 год 12 хв» · `hours(h, dec?)` «12,5 год» · `num(n, dec)` «12 345,5» · `int(n)` · `pct(0–100)` «85 %» · `frac(0–1)` «85 %» ·
`plural(n, ['запис','записи','записів'])` · `inputDT(d)` / `fromInputDT(s)` для `datetime-local` і `inputDate(d)` для `type=date` —
**у поясі заводу**, як і весь показ часу (планшет чи ПК керівника в іншому поясі вводить час за годинником цеху) ·
`dayStart('YYYY-MM-DD')` → Date (північ дня в поясі заводу) · `parts(d)` `{y,m,d,H,M,S,wd}` · `setTz(tz)`/`tz()` (App задає сам).

### 6.3 Мітки, стани, іконки

* `UI.LABELS` (= `LinesCore.LABELS`), `UI.label(set, code)`, `UI.stateLabel(state)`,
  `UI.options('work_type', {only:[…]})` → `[{value,label}]` для select/chips.
* `UI.STATES` = `['run','stop','setup','clean','maint','repair','off']` (порядок показу);
  `UI.stateColor(s)` → `'var(--st-run)'`; `UI.STATE_ICON[s]` → назва іконки.
* `UI.icon(name, size=22, cls?)` — inline SVG (`currentColor`). Назви: `menu x check back next down up user users refresh sun moon
  alert info wrench clock play pause stop power list checklist plus minus trash lock logout grid backspace droplet activity calendar
  search download upload edit tablet shield cloud cloudOff gauge history settings home chart file printer wifi link external box tool
  sliders eye copy send dot`.

### 6.4 Компоненти (HTML-рядки)

| Виклик | Опис |
|---|---|
| `UI.statusPill(state, {since, size:'sm'|'lg'|'xl', soft, label, pending, timer:'dur'|'clock'|'durs'|'rel'|false})` | пігулка стану кольору SPEC 4.3; з `since` — живий таймер |
| `UI.timer(since, fmt='dur')` | живий `<span data-since>` (оновлюється щосекунди) |
| `UI.badge(text, tone, {icon, title})` | `tone`: `due` (червоний, суцільний) · `bad` (червоний контур) · `soon`/`warn` (бурштин) · `ok` · `info` · `accent` · `muted` · або код стану |
| `UI.progress(pct, status, {label, className:'lg'})` | смуга ТО; `pct` — частка (1 = 100 %, >1 — штрихування перевищення) |
| `UI.bigButton({label, sub, icon, tone, solid, action, value, href, disabled, badge, chevron, className:'compact', attrs})` | велика кнопка дії (`data-action`, `data-value`); `tone` — код стану \| `primary` \| `danger` \| `ok` \| `info` \| `muted` |
| `UI.tile({title, kicker, body, foot, href, state, tone, attrs, className})` | узагальнена плитка з кольоровою смугою |
| `UI.pageHead({title, kicker, sub (HTML), back ('#/…'|true), actions (HTML)})` | заголовок сторінки з кнопкою «Назад» (`data-back`) |
| `UI.chips({name, options:[{value,label,tone,icon,count,disabled}]|['…'], value, multi, allowEmpty, size:'sm', label})` | чипи вибору; клік → подія `change` (bubbles) на контейнері з `detail {name, value, values}`; `UI.chipValue(root, name)`, `UI.setChipValue(root, name, v)` |
| `UI.segmented({…як chips})` | сегментований перемикач (одне значення) |
| `UI.field(o)` / `UI.field.text/number/select/textarea/datetime/date/check/chips/password/email/url(o)` | поле: `{name, label, value, required, hint, placeholder, id, attrs, className:'span-2', disabled, maxLength, inputmode, datalist:[…] (text), unit (number), options (select/chips), rows (textarea)}`; `number` = `type=text inputmode=decimal data-type=num` (кома дозволена) |
| `UI.emptyState({icon, title, text, action:{label, href|action, tone}})`, `UI.spinner(text)`, `UI.loading(host, text)` | порожній стан / завантаження |
| `UI.kv([[label, htmlValue], …])` | список «назва — значення» (значення — готовий HTML) |
| `UI.bars([{label, value, color, valueText, title}], {max, unit, fmt, empty})` | горизонтальні CSS-смуги |
| `UI.stackBar([{value, color, label, valueText}], {height, title})`, `UI.stateBar(hours:{state:h}, {height})` | складена смуга (години за станами) |
| `UI.legend([{label,color}])`, `UI.stateLegend(only?)` | легенда |

Форми: `UI.readForm(root)` → `{name: value}` (checkbox → bool; `data-type=num` → число|null; `datetime` → ISO|'';
`date` → 'YYYY-MM-DD'; чипи → значення/масив); `UI.setErrors(root, {name:'Текст'})` → `true`, якщо є помилки (фокус на першій);
`UI.clearErrors(root)`.

### 6.5 Інтерактивні

| Виклик | Опис |
|---|---|
| `UI.modal({title, body (HTML|Element|масив), actions:[{label, tone:'primary'|'danger'|'ghost'|'ok', value, onClick(m,e), icon, autofocus, disabled, className, id}], size:'sm'|'md'|'lg'|'full', locked, className, onClose(v), initialFocus, noHead})` | → `{root, box, body, foot, head, result:Promise, close(v), setBusy(b), setError(msg), setLocked(b), setTitle(t), button(i)}`. Пастка фокуса; Esc / фон / ✕ закривають з `null`, якщо не `locked`. `onClick`: `false` — не закривати; `Promise` — кнопки блокуються, значення ≠ `false` стає результатом; виняток → `setError`. На телефоні — нижня панель |
| `UI.confirm('Текст' | {title, text, html, ok, cancel, danger})` | → `Promise<boolean>` |
| `UI.alert(text | {title, text, html, ok})` | → `Promise` |
| `UI.prompt({title, label, text, value, placeholder, required, multiline, maxLength, ok, inputmode, hint})` | → `Promise<string|null>` |
| `UI.choose({title, text, options:[{value, label, sub, icon, tone, disabled}], columns:2, cancel:false|'Текст', size})` | великі кнопки вибору → `Promise<value|null>` (причини простою, наступний стан) |
| `UI.keypad({title, text, hint, mode:'pin'|'decimal'|'int', value, minLength, maxLength, unit, allowNegative, allowEmpty, submitLabel, onSubmit(v) → true | 'помилка' | Promise})` | екранна клавіатура (працює й фізична) → `Promise<string|null>` (десятковий — з комою: `UI.num(s)`) |
| `UI.toast(msg, {tone:'ok'|'warn'|'err'|'info', ms (0 = не зникати), action:{label, onClick}})` | сповіщення внизу (під модальними вікнами) |
| `UI.menu(anchorEl, [{label, icon, onClick, href, danger, checked, disabled, sub} | {sep:true}], {className})` | спливне меню → `{close}` |
| `UI.table({columns:[{key, label, num, dec, sortable=true, value(row), render(row)→HTML, csv(row), className, width, title}], rows, sort:{key, dir}, empty, onRow(row,e), rowClass(row), rowAttrs(row), maxHeight, className, caption})` | → `HTMLElement` (`div.tbl-wrap`) з `setRows(rows)`, `getRows()`, `sortBy(key, dir)`; порожні значення при сортуванні — внизу; клас рядка `is-void` — закреслення |
| `UI.csv('журнал.csv', columns, rows)`, `UI.download(name, content, mime)` | CSV для Excel (`;`, BOM, кома в числах, захист від формул) |
| `UI.tick(root)` | оновити всі `[data-since]` (App робить це щосекунди) |
| `UI.isModalOpen()` | чи відкрито модальне вікно |

---

## 7. CSS (styles.css)

Теми: `:root` (темна) і `:root[data-theme=light]` (яскравий цех). Вмикає `App.setTheme('dark'|'light')`.
Використовуйте ЛИШЕ змінні, не кольори:

* поверхні `--bg --bg-2 --panel --panel-2 --panel-3`, лінії `--line --line-soft --line-strong`, текст `--ink --muted --dim`;
* акцент `--accent` (текст) / `--accent-bg` (заливка) / `--accent-ink` (текст на заливці) / `--accent-soft` / `--accent-line`;
* сигнали `--ok --warn --bad --info` (+ `-soft`), `--bad-bg`;
* стани `--st-off --st-run --st-setup --st-stop --st-repair --st-maint --st-clean`, `--st-ink` (текст на заливці стану);
  клас `.st-<state>` задає `--st` (для власних елементів: `background:var(--st)`), `.tone-<x>` — `--tone`;
* розміри `--tap:52px` (мінімум для дотику), `--topbar`, `--gutter`, `--r`, `--r-lg`; шрифти `--f-display` (Plex Sans Condensed),
  `--f-body`, `--f-mono`.

Класи-примітиви:

* каркас: `.page` (host), `.page-head` (`UI.pageHead`), `.section-title`, `.stack`, `.row`, `.grow`, `.cols-2/3/4` (складаються на вузьких),
  `.grid-auto` (плитки ≥320px), `.card` + `.card-head` (+ `.hint`) + `.card-body` (`.flush`), `.list` + `.list-item` (`.li-main .li-t .li-s .li-err`) + `.list-empty`,
  `.box` (`.ok .warn .err .info`), `.kv`, `.form-grid` (+ `.span-2`), `.form-actions`, `.btn-row` (`.end`), `.sep`;
* кнопки: `.btn` (52px) `.primary .danger .ok .ghost .outline .sm .lg .block .icon`; `.bigbtn` (`.solid .compact`, `.tone-*`);
* стани: `.pill` (`.sm .lg .xl .soft .pending`, `.st-*`), `.badge` (`.b-due .b-bad .b-soon .b-ok .b-info .b-accent .b-muted`), `.badges`,
  `.prog` (`.s-ok .s-soon .s-due .s-none`, `.lg`);
* ввід: `.field`, `.inp`, `.inp-wrap` + `.inp-unit`, `.check`, `.chips`/`.seg` (`.sm`, `.seg.block`), `.chip.on`;
* таблиці: `.tbl-wrap` + `table.tbl` (`td.num`, `tr.clickable`, `tr.is-void`);
* смуги: `.hbars`, `.sbar`, `.legend`;
* текст: `.muted .dim .mono .num (tabular) .cond .small .big .upper .nowrap .ellipsis .right .center .c-ok .c-warn .c-bad .c-info`;
* `.empty`, `.spin-wrap`/`.spinner`, `.wip` (заглушки), `.no-print`.

Адаптивність: 1280×800 і 800×1280 (планшет), до 360px без горизонтальної прокрутки (точки 1100/900/720/560/480/420/370/340 px).
Заголовок `.page-head` має власну основу (до 280px): дії (`.ph-act`) переносяться під нього, а не стискають його;
довгі слова не розриваються посеред слова (`overflow-wrap:break-word`, `hyphens:auto`, менший `h1` на ≤420px).
У вікні стискається лише `.modal-body` (прокрутка) — заголовок і кнопки завжди видно повністю.
`prefers-reduced-motion` вимикає анімації; є базовий `@media print`.
Ваші стилі — лише в `operator.css` / `manager.css`, з префіксами класів (`op-…`, `m-…`), без зміни глобальних примітивів.

---

## 8. Події `App.on(name, fn)` → відписка

`boot (state, meta)` — нові дані · `queue (netInfo)` · `net (netInfo)` · `route (ctx)` · `operator (op|null)` ·
`admin (bool)` · `theme ('dark'|'light')`.

---

## 9. Сховище пристрою (localStorage / sessionStorage)

| Ключ | Вміст |
|---|---|
| `fl_lines_v1` | налаштування пристрою (`Api.config()`) |
| `fl_lines_queue` / `fl_lines_rejected` | черга / відхилені операції |
| `fl_lines_boot` | кеш bootstrap `{target, at, data}` |
| `fl_lines_skew` | поправка годинника: найточніший замір `{skew /*мс*/, rtt, at}` |
| `fl_lines_demo_v1` | дані демо-режиму (`LocalStore`) |
| session `fl_lines_admin` | PIN керівника на сеанс |
| session `fl_lines_transport` | `{endpoint, t:'jsonp'}` — перемикання на JSONP (POST перевіряється знову у фоні) |

Сховище переповнене → `Api` звільняє місце (видаляє кеш `fl_lines_boot`, а поза демо-режимом — залишки
`fl_lines_demo_v1`) і повторює; не вдалося — черга / відхилені живуть у пам’яті вкладки (`storage_full`).

Сервіс-воркер (`sw.js`): кеші з префіксом `fl-lines-`; спершу мережа для власних файлів, спершу кеш для шрифтів Google;
дані (`script.google.com`, `*.googleusercontent.com`, запити з `action=`/`callback=`, службові адреси емулятора `/__*`,
будь-які POST) не кешуються.
Реєструється лише на https / localhost. Під час релізу змінюйте `?v=` в `index.html`, `SHELL_FILES` і `VERSION` у `sw.js` —
планшети покажуть «Доступна нова версія» → «Оновити». Встановлення нової версії вдається лише з повним кешем
оболонки (без іконок — можна): якщо мережа зникла посеред оновлення, працює попередня версія з повним кешем;
старі кеші видаляються, лише коли кеш нової версії повний. Узгодженість (одна версія, усі скрипти/стилі/іконки в `SHELL_FILES`,
файли існують) перевіряє тест «реліз» у `tests/e2e.test.mjs` (працює й без браузера).

---

## 10. Глобали екранів: `Operator` і `Manager`

Екрани оператора й керівництва реєструють маршрути самі; назовні вони віддають кілька функцій для повторного
використання (інший екран, тести). Інших глобалів ці файли не створюють.

### 10.1 `window.Operator` (operator.js)

| Виклик | Опис |
|---|---|
| `Operator.openWorkForm(opts)` | модальна форма запису роботи (та сама, що на `#/line/:id/work`) → `Promise<{ids, works, writes} \| null>`; `null` — скасовано або не вибрано оператора. `writes` — масив `Promise` від `Api.write('work', …)` (по одному на роботу) |
| `Operator.markDone(lineId, ruleId)` | «Позначити виконаним» роботу регламенту: `openWorkForm({mode:'rule'})` + тост → `Promise` як вище |
| `Operator.showDue(ruleId)` | деталі строку ТО (критерії, інструкція) з кнопкою «Позначити виконаним» |
| `Operator.openReadings(lineId)` | вікно показників лічильників лінії (потрібен оператор) → `Promise<true \| null>`; записи — `Api.write('reading')` |
| `Operator.showCheck(id, ts, row?)` | відповіді чек-листа (`check_detail`; `row` — рядок історії для заголовка) → `Promise` закриття |
| `Operator.showWork(work)` | картка роботи (обʼєкт з історії / `line`) → `Promise` закриття |
| `Operator.stripHtml(segs, fromMs, toMs, o?)` | HTML стрічки станів за вікно `[from, to)`; `segs = [{state, from, to, reason?, product?, pending?}]` (мс); `o: {axis, cls, info, label}` |
| `Operator.evalItem(item, value, note?)` | оцінка відповіді як у ядрі → `{answered, ok: true\|false\|null, text, num}`. `note` — примітка до пункту: «Н/З» в обовʼязковому пункті без примітки (або в критичному — завжди) → `ok:false` (зауваження); з приміткою (у некритичному) — `ok:null`. Без `note` «Н/З» в обовʼязковому пункті дає `ok:false` |
| `Operator.needStartCheck(lineId)` | чи потрібен чек-лист запуску перед «Працює» → `Promise<boolean>` |
| `Operator.ranSinceOff(lineId)` | чи працювала лінія після останнього «Не працює» → `Promise<true \| false \| null /*невідомо*/>` |

`openWorkForm(opts)`:

| Поле | Значення |
|---|---|
| `line_id` | **обовʼязково**; невідома лінія → повідомлення і `null` |
| `mode` | `'free'` (типово) \| `'repair'` \| `'maint'` (кілька робіт регламенту разом) \| `'rule'` (одна робота регламенту) \| `'clean'` \| `'setup'` |
| `rule_id` / `rule_ids` | вибрані роботи регламенту (лише цієї лінії; для не-`maint` — перша) |
| `work_type`, `unit_id`, `title`, `cause`, `description`, `product`, `downtime_min` | початкові значення полів |
| `started`, `finished` | ISO / `Date`; `finished` типово — `App.now()` |
| `operator` | `{name, staff_id}` — виконавець за замовчуванням |
| `requireOperator` | `true` (типово) — спершу `App.requireOperator(line_id)`; `false` — без вибору оператора (виконавця вводять у формі; так робить керівник) |
| `heading`, `submitLabel` | заголовок вікна і напис кнопки; `silent: true` — без тосту «Роботу записано» |

```js
// з розділу керівника: та сама форма, що на планшеті
Operator.openWorkForm({ line_id: 'L2', mode: 'rule', rule_id: 'R3', heading: 'Позначити виконаним', requireOperator: false })
  .then((r) => { if (r) return Promise.all(r.writes); });
```

Записи з екранів оператора йдуть через внутрішню обгортку над `Api.write` (позначає дані лінії застарілими після
підтвердження). Її додатковий `Api.flush(true)` через 80 мс після запису був обходом гонки в `Api.flush`, яку
виправлено (див. §4.3) — тепер він нешкідливий і не потрібен новому коду.

### 10.2 `window.Manager` (manager.js)

| Виклик | Опис |
|---|---|
| `Manager.markDone(due, onDone?)` | «Позначити виконаним» з розділу керівника: `due` — due-обʼєкт (`{rule_id, line_id, unit_id?, work_type?, title?}`); форма — `Operator.openWorkForm` (без вибору оператора), а якщо екрана оператора немає — компактна форма керівника. `onDone(result)` — після підтвердження записів |
| `Manager.openCheck(id, ts?, onDone?)` | чек-лист із відповідями (`check_detail`) і кнопкою «Анулювати» → `Promise` закриття |
| `Manager.openRecord(kind, row, onDone?)` | картка запису журналу; `kind`: `'events' \| 'checks' \| 'works' \| 'readings'` (`checks` → `openCheck`); «Анулювати» → `void` з причиною; `onDone()` — після анулювання |
| `Manager.refreshCache()` | скинути кеш розділу (довідники керівника, огляд, план) — наступний показ завантажить свіжі дані |

Розділи керівника — `#/m/<id>` з канонічними id (§1.4): **`maintenance`** для «ТО і ППР» (`maint` — псевдонім).
Дії керівника — `Api.call` (потрібен звʼязок); доступ — після `App.requireAdmin()` (PIN).

---

## 11. Локальний емулятор і наскрізні тести

`tools/dev-server.mjs` (без залежностей) роздає `lines/` як сайт і відповідає на `/exec` як веб-застосунок Apps Script:
виконує **справжні** `core.js` + `Server.gs` через `tools/gas-mock.mjs` над таблицею в памʼяті (`setup()` при старті).

```
npm run dev                         # = node tools/dev-server.mjs --seed  → http://localhost:8787/
node tools/dev-server.mjs --port 8787 --host 127.0.0.1 --seed --token dev-token --admin-pin 1234 \
                          --latency 300 --persist /tmp/lines.json --verbose
```

У майстрі планшета: «Google-таблиця підприємства» → адреса `http://localhost:8787/exec`, токен `dev-token`;
PIN керівника — `1234` (друкуються при старті). `--persist` зберігає таблицю (значення аркушів і властивості скрипту)
у JSON між запусками; `--host 0.0.0.0` — доступ з планшета в мережі (без https сервіс-воркер там не працює).
Службові адреси `/__*` відповідають лише цьому компʼютеру (loopback), без CORS; запити з чужих сторінок (Origin /
`Sec-Fetch-Site: cross-site|same-site`) і з чужим `Host` (DNS rebinding) → 403. `--expose-control` дозволяє їх з мережі
(обережно: `/__sheets` віддає всю таблицю разом із PIN персоналу). Файл `--persist` статично не роздається.
Сервіс-воркер застосунку службові адреси `/__*` не кешує.

| Адреса | Призначення |
|---|---|
| `POST /exec` (text/plain JSON) → `doPost`; `GET /exec?action=…&payload=…[&callback=fn]` → `doGet` (JSON або JSONP) | API, як у Google (CORS `*`, `OPTIONS` → 405 — preflight не підтримується, як і в Apps Script) |
| `POST /__control {"down":true\|false}` | «аварія»: зʼєднання з `/exec` обривається (статичні файли працюють). Команди `/__control` — лише `POST` з `Content-Type: application/json` (інакше 415) |
| `POST /__control {"offline":true\|false}` | «мережі немає»: обриваються і `/exec`, і статичні файли (зокрема запити сервіс-воркера — оболонка лише з кешу) |
| `POST /__control {"blockPost":true}` | обривати лише POST — клієнт переходить на резервний канал JSONP |
| `POST /__control {"loseResponses":N}` | наступні N записів виконати, але обірвати зʼєднання замість відповіді (перевірка ідемпотентних повторів) |
| `POST /__control {"latency":мс}` · `{"reset":true,"seed":true}` · `{"run":"hourlyJob"}` | затримка; нова таблиця; серверна функція (`hourlyJob, dailyJob, refreshPlan, recomputeAll, checkDueNow, sendDigestNow, seedDemoData, setup`) |
| `GET /__control` (або `POST {}`) | стан `{down, offline, block_post, latency, lose_responses, requests, static_served, dropped_static, dropped_exec}` без токена й PIN; `GET` із параметрами → 405 |
| `GET /__sheets[?name=Журнал стану][&values=1]` | дані аркушів `{name, header, rows:[{Заголовок: значення}]}` (дати — ISO) |
| `GET /__mails`, `GET /__requests` | надіслані листи; журнал запитів до `/exec` (дія, пакет, результати `ok/duplicate/…`, `lost`) |

У коді: `const srv = await startDevServer({port: 0, seed: true, token, adminPin, latencyMs, persistFile, exposeControl, quiet: true})` →
`{url, endpoint, token, adminPin, port, setDown(), setOffline(), blockPost(), loseResponses(n), setLatency(), reset(), run(), sheets(), mails(), requests(), stats(), project, close()}`.

Тести: `npm test` — ядро і сервер (без встановлень); `npm run test:e2e` — Playwright (глобальний пакет, headless Chromium;
без Playwright файл пропускається з поясненням); `npm run test:all` — усе. Сценарії e2e: демо-режим (майстер, повна зміна
оператора, керівник: огляд, річний графік, нова лінія / агрегат / пункт / регламент), віддалений режим через емулятор
(майстер, записи в аркушах з українськими назвами, «аварія» з чергою й повтором без дублікатів, JSONP, PWA-старт без мережі
(сервер обриває й запити сервіс-воркера — оболонка лише з кешу), ТО з екрана лінії, анулювання в журналі), захист службових
адрес емулятора, 360 px без горизонтальної прокрутки, без помилок у консолі.
