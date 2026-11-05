# QuarryVault — Targeted Root-Cause Investigation & Safe Remediation Planning

**Investigation date:** 2026-10-30
**Target:** `C:\Users\Mina Max\Downloads\0xAnub1sX\quarryvault`
**Mode:** Static, read-only inspection plus read-only `git show`/`git diff` of committed history. No source, configuration, database, or infrastructure changes were made. No gradle commands, backend test runs, or builds were executed by this investigation.

**Final status: ROOT CAUSES PARTIALLY CONFIRMED.** Four of the five reported Android symptoms have confirmed, code-derived causes traceable to specific functions. Issue 1 (Create Quarry input) has no reproducible "typing failure" mechanism in either obtainable source state (committed HEAD or the current uncommitted tree); one confirmed blocking window remains, and the exact shipped build that produced the symptom cannot be reconstructed. Issue 5 (LTR flash) has a confirmed structural cause with one implementation-level detail (the exact flashed frame) still requiring on-device confirmation.

---

## 0. Repository state that materially changes the diagnosis (READ FIRST)

The working tree is **not** the committed state. This investigation independently established the following timeline from file metadata, `git status`, `git show HEAD:...`, and build artifacts:

| Artifact | Timestamp | Meaning |
| --- | --- | --- |
| HEAD commit `0fab6da` | 2026-10-27 09:54 | Last committed snapshot ("feat: complete platform upgrade …"). Contains **original buggy behavior** for Issues 3, 4, 5. |
| `Al-Manzouma.apk` (repo root, 20.6 MB) | 2026-10-29 16:11 | Distributed APK. Built **before** the current uncommitted fixes. |
| Android source edits (`EmployeeAppViewModel.kt`, `MainActivity.kt`, `HomeScreen.kt`, `DocumentActionsHelper.kt`, `QuarryDetailScreen.kt`, `EmployeeAppScreen.kt`, …) | 2026-10-30 17:49–18:10 | **Uncommitted fix attempt** for exactly the five reported bugs (new test file section header: *"Critical Bug Fixes Regression Suite (Form input, Refresh, Overflow Menu, Download, Print)"* in `EmployeeAppViewModelTest.kt:752-754`). |
| `android/app/build/outputs/apk/release/app-release-unsigned.apk` (versionCode 31) | 2026-10-30 18:13 | Post-fix build artifacts. |
| `android/app/build/outputs/apk/debug/app-debug.apk` (versionCode 33, `android/version.properties` stamped 18:29:25) | 2026-10-30 18:29 | Post-fix build. |

Consequences:

1. **The user's reported symptoms are consistent with the 2026-10-29 APK** as the currently installed build; that build predates every fix present in the working tree. Reproduction of "old" behavior against HEAD is therefore expected and explains why the report and the fixes can both be true simultaneously.
2. **All five bug fixes are uncommitted.** Any further change session that resets/overwrites the working tree destroys the fix attempt. First recommended action (implementation phase, not this one): commit the current tree.
3. The previous audit's line references (e.g., "EmployeeAppViewModel.kt is 3,123 lines") correspond to the **working tree at audit time**, which has since changed (now 2,931 lines). Both states were considered where relevant.

---

## 1. Executive summary

- **Issue 3 (Download → preview) and Issue 4 (Print → preview) — ROOT CAUSES CONFIRMED at HEAD.** In the committed code, `QuarryDetailScreen.kt` had **one single action payload** (`downloadedDocumentData`) that all three actions (View / Download / Print) wrote to, and a single `LaunchedEffect` that **always called `openDocument()`** on completion. Nothing was ever saved to the device: `saveDocumentToDownloads()` did not exist at HEAD. Additionally, `printDocument()` at HEAD explicitly **fell back to `openDocument()` for non-PDF files**. The uncommitted working tree contains a correct three-state redesign (`downloadedDocumentData` / `pendingOpenDocumentData` / `pendingPrintDocumentData`) plus a MediaStore-based downloader and a PDF/image PrintManager printer; it is code-consistent and covered by new regression tests, but **has not been verified on a device in this investigation**.

- **Issue 2 (Pull-to-refresh stuck) — ROOT CAUSE CONFIRMED as a code + library interaction, and it is still live in the current tree.** Pull-to-refresh did not exist at HEAD (there were only manual refresh IconButtons); it was added in the uncommitted changes. The refresh functions set `isRefreshing = true` then `false` around a repository call with **no minimum frame gap**. When the API responds faster than one display frame — which is the normal case for instant network failures (`ApiResult.Error(401, "No authentication token available")` is returned without any suspension in `EmployeeRepository.executeWithTokenRenewal()`) and common against the debug LAN backend (`http://192.168.1.8:8000`, `android/app/build.gradle.kts`) — both transitions coalesce into one frame. This is the exact, publicly documented Material 3 ≤ 1.3.0 `PullToRefreshBox` defect ("indicator gets completely stuck"; fixed in material3 1.4.0-alpha01). This project pins `composeBom = "2024.10.01"` → material3 **1.3.0** (`android/gradle/libs.versions.toml`), i.e. the fixed release is **not** in this build.

- **Issue 5 (Create Quarry dialog renders LTR, then RTL) — structural cause confirmed; frame-level flash is a high-confidence hypothesis.** Layout direction is decided from three inconsistent authorities simultaneously: (a) `MainActivity.onCreate` forces `window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL` (added in the uncommitted fix); (b) dialogs are separate windows whose direction is derived from the **device configuration/locale** (typically English → LTR on the target devices), not from the activity's overridden view direction; (c) screens mitigate this with per-screen and per-dialog-slot `CompositionLocalProvider(LocalLayoutDirection provides …)` wrappers. The window-level force and the per-slot providers disagree during dialog presentation, producing an LTR first paint followed by the provider-driven RTL painting. At HEAD the situation was worse and included a **language toggle** (`isArabic = false` default): the whole app started LTR with an in-app toggle that flipped direction at runtime.

- **Issue 1 (Create Quarry fields do not accept input) — NOT fully confirmed.** Both obtainable source states (HEAD single-field dialog; current three-field dialog) use properly state-driven `OutlinedTextField`s wired to `EmployeeAppViewModel.onNewQuarryNameChanged()` etc., and `MutableStateFlow.update` cannot lose keystrokes. No "silent typing-drop" mechanism exists in either snapshot. What **is** confirmed: the fields are `enabled = !uiState.isCreatingQuarry`, and during a create attempt against a cold server they are disabled for up to OkHttp's ~15–45 s timeout window with no inline progress indication — a user attempting to type during that window sees exactly "typing does not work". Whether the original symptom was this window, the (later fixed) dialog rewrite, or a device-specific issue cannot be proven from this repository. Requires on-device verification with the current build.

- Backend findings QV-001, QV-003, QV-004, QV-005, QV-008 were **independently re-verified against current source and all stand** (QV-004 refined: the test setup falls back to an in-memory `MongoMemoryServer` when its default URI is unreachable, but retains the destructive `deleteMany({})` against any *reachable* configured URI, with no isolation assertion). **QV-002 is unchanged and still live**: `SessionStorage.kt:111-143` still derives the AES key from the hard-coded constant `quarryvault_secure_keystore_salt` and still fails open to plaintext on any crypto exception — the current fix attempt did not touch it.

- No test or build commands were executed (see §2). The android Gradle build writes `version.properties` / `.gradle/version.lock`; the backend vitest setup destroys collections in whatever MongoDB it connects to; the admin workspace has no test script. Corroborating external fact: the frontend README/docs test-count inconsistencies noted previously (QV-007) remain as documentation-only issues and were not re-audited.

---

## 2. Phase 2 — Safe reproduction assessment

**Nothing was executed.** Unsafe artifacts previously recorded remain true and were re-confirmed:

- `backend/tests/setup.ts:7-14` connects to `TEST_MONGODB_URI` or, failing that, a reachable `mongodb://127.0.0.1:27017/quarryvault_test` — and **only falls back to a disposable in-memory `MongoMemoryServer` if the primary URI cannot connect within 2 s** (`backend/tests/setup.ts:11-13`). `beforeEach` (`backend/tests/setup.ts:26-33`) then deletes every collection. `vitest.config.ts:9` loads it globally with `fileParallelism: false`. Dry-running the suite on this machine would wipe `$env:USERPROFILE`-local `quarryvault_test` (or any `TEST_MONGODB_URI` target) if a local mongod is running.
- `android/app/build.gradle.kts:33-99` (`resolveAppVersion()`) locks and writes `android/version.properties` + creates `.gradle/version.lock`, and increments `version.code` for APK-producing tasks. This is observable: `version.properties` was already stamped `#Fri Oct 30 18:29:25 EET 2026` and `version.code=33` by yesterday's unauthorized builds. Invoking Gradle here would write again.
- The admin workspace declares no `test` script (`admin/package.json`).

**What could be safely run if approved, and what each run would prove** (recommendations, not executed):

1. Backend suite **only** after `TEST_MONGODB_URI` is confirmed to point at a disposable instance (name assertion added first — see QV-004 remediation). It would exercise `backend/tests/security_authorization.test.ts` (QV-003 codification) and the idempotency/recovery suites.
2. `:app:compileDebugUnitTestKotlin` would validate that the uncommitted fix attempt + new test files compile (their API cross-references were read but not compiler-verified). It writes build dirs and (per current config) bumps `version.code` only for APK tasks; `test*` tasks preserve version (`build.gradle.kts:27-29, 94-97`).
3. On-device verification (`adb install -r` of `app-debug.apk`, versionCode 33) against a disposable local backend is the **only** way to settle Issue 1 and the Issue 5 flash; both are UI/runtime-observable. This investigation could not do it (no emulator permitted, no changes allowed).

Code-derived vs runtime-confirmed is labeled per issue below.

---

## 3. Phase 1 — Per-issue root-cause analysis

Legend: **[C]** = confirmed code-derived root cause; **[H]** = hypothesis, code-supported, needs runtime confirmation; **[F]** = fix present in uncommitted tree, correctness reviewed but not runtime-verified.

---

### 3.1 Issue 3 — "Download opens a preview instead of downloading" — **[C] at HEAD / [F] in working tree**

**Exact sources (HEAD, committed):**
- `android/app/src/main/java/com/quarryvault/employee/ui/screens/QuarryDetailScreen.kt:94-99` —

  ```kotlin
  // Effect to handle view/print when download completes
  LaunchedEffect(uiState.downloadedDocumentData) {
      val data = uiState.downloadedDocumentData
      if (data != null) {
          DocumentActionsHelper.openDocument(context, data.first, data.second)
      }
  }
  ```
- `QuarryDetailScreen.kt:410-414` (HEAD) — inside `DocumentCard` usage:
  `onView = { onDownloadDocument(doc) }`, `onDownload = { onDownloadDocument(doc) }`, `onPrint = { … onDownloadDocument(doc) }` — **all three actions call the same single handler** (`onDownloadDocument` is the only action parameter, line 44).
- `EmployeeAppViewModel.kt` (HEAD, lines ~722-745): `downloadDocument()` fetches bytes and sets `downloadedDocumentData = Pair(document, result.data)`.
- HEAD `DocumentActionsHelper.kt` had **no** `saveDocumentToDownloads` at all (added by the uncommitted fix; diff hunk `+39..83`).

**Root cause (confirmed, HEAD = shipped APK behavior):** There was a single action→state→effect pipeline. Completing *any* of the three actions produced `downloadedDocumentData`, and the UI layer **unconditionally opened the bytes in an external viewer** (`ACTION_VIEW` chooser). The bytes were never persisted (no MediaStore/file write existed), so a user choosing "تحميل/Download" observed: brief spinner → preview opens → no file appears in Downloads. Expected behavior: Download must write the file to `MediaStore.Downloads/QuarryVault` (API ≥ 29; `minSdk = 26` needs the legacy path) and notify; View should preview; Print should print.

**Code path (HEAD):** menu "Download" → `QuarryDetailScreen.DocumentCard(onDownload)` → `onDownloadDocument` → `EmployeeAppScreen` wiring (HEAD `EmployeeAppScreen.kt:75`, retrievable via `git show HEAD:android/app/src/main/java/com/quarryvault/employee/ui/screens/EmployeeAppScreen.kt`: `viewModel.downloadDocument(it)`) → `EmployeeAppViewModel.downloadDocument` → … → `uiState.downloadedDocumentData` → `LaunchedEffect` → `DocumentActionsHelper.openDocument()` → **preview window**. The download "succeeded" only in memory (progress toast even said *"Downloaded … (N bytes)"*, reinforcing confusion).

**Current state [F]:** Working tree separates the three payload states (`EmployeeAppViewModel.kt:187-189` UIData class fields; handlers at 1703 / 1866 / 1928; separate `LaunchedEffect`s at `QuarryDetailScreen.kt:107-131` with `onClearDownloadedDocumentData`/`onClearPendingOpenDocument`/`onClearPendingPrintDocument`), and `DocumentActionsHelper.saveDocumentToDownloads()` (`DocumentActionsHelper.kt:39-83`) now writes via `MediaStore.Downloads` (Q+) or `Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS)` (< Q) with failure toast and `null` return. ViewModel-level separation is regression-tested (`EmployeeAppViewModelTest.kt:856-898` `download_view_print_actions_areCompletelySeparated`).

**Residual findings in the fix (present, not yet corrected):**
- `QuarryDetailScreen.kt:59` exposes a new parameter `onDownloadDocumentToUri: ((Document, Uri) -> Unit)? = null` that `EmployeeAppScreen.kt` never passes, and `EmployeeAppViewModel.downloadDocumentToUri()` (`EmployeeAppViewModel.kt:1771-1864`) is unreachable dead code (it also re-sets `downloadedDocumentData` after successfully writing the URI, which would trigger the save-to-Downloads effect **a second time** — a future double-save bug if ever wired up).
- On API < 29 (`minSdk 26`), `saveDocumentToDownloads` writes to public external storage **without WRITE_EXTERNAL_STORAGE permission** — manifest declares none; on API 26–28 devices this throws → toast failure. Target devices today are API 29+ in practice, but it is an unhandled supported-OS case.
- Filename MIME mismatch handling is fine; `ContentDispositionParser.kt:36-60` correctly prefers RFC 5987 `filename*` (Arabic names preserved).

**Regression tests required:** (already added, but must actually run + device smoke) — run of `EmployeeAppViewModelTest`, plus an interface-level test would also be warranted for the save path (current tests cover ViewModel only, not `saveDocumentToDownloads` MediaStore interaction; MediaStore inserts are hard to unit-test — accept manual QA or Robolectric).

**Environment limits:** device installation required; MediaStore behavior cannot be verified statically.

---

### 3.2 Issue 4 — "Print opens a preview instead of printing" — **[C] at HEAD / [F] in working tree**

**Exact sources (HEAD):**
- `DocumentActionsHelper.kt:60-107` (HEAD numbering): `printDocument(context, document, bytes)` —

  ```kotlin
  val printManager = context.getSystemService(Context.PRINT_SERVICE) as? PrintManager
  if (printManager != null && isPdf) { … printManager.print(…) }        // :66-104
  else {
      // Fallback for non-PDF: Open system chooser / view
      openDocument(context, document, bytes)                              // :106-107
  }
  ```
- `QuarryDetailScreen.kt:412-414` (HEAD): the Print menu item calls the shared `onDownloadDocument(doc)` — i.e., Print was never routed through `DocumentActionsHelper.printDocument()` under the UI wiring at all (the helper's print path was effectively dead from the Detail screen; the shared handler's result always ended in `openDocument`).

**Root cause (confirmed, HEAD):** Two-layer failure:
1. **Wire-level:** Print invoked the same handler as Download/View (single `downloadedDocumentData` state; no `pendingPrintDocumentData`), so the print-specific helper never ran from the UI.
2. **Helper-level:** even when `printDocument()` ran, only PDF triggered `PrintManager.print`; **any non-PDF (including every image and Office file) fell through to `openDocument()`** — literally documented in the code comment "Fallback for non-PDF: Open system chooser / view".

Expected behavior: Print invokes the Android printing framework (`PrintManager.print` with a `PrintDocumentAdapter`) for printable formats and refuses (with an explanatory message) unsupported ones; it must never fall back to a content viewer.

**Current state [F]:**
- `QuarryDetailScreen.kt:152` now wires the dedicated `onPrintDocument = { viewModel.printDocument(it) }`; `EmployeeAppViewModel.printDocument()` (lines 1928-1988) fills `pendingPrintDocumentData`; `QuarryDetailScreen.kt:125-130` runs `DocumentActionsHelper.printDocument`.
- `DocumentActionsHelper.kt:114-229` (current): PrintManager path for **PDF** (streams stored PDF bytes to the print destination), **images** (raster → `PdfDocument` on the fly, lines 166-214), and an explicit unsupported-format toast (lines 215-221) instead of opening a viewer. The wrong fallback is gone.

**Format support (explicit):** PDF → direct; image MIME/`png|jpg|jpeg|webp` → converted single-page PDF then printed; **everything else (Office docs, text, videos) is refused with a toast** — that is the correct minimal behavior. Regression tests for the ViewModel event separation exist (`EmployeeAppViewModelTest.kt:890-897`). The `PrintDocumentAdapter` itself still lacks tests (requires instrumented/framework mocking — noted as a gap, optional).

**Environment limits:** printing end-to-end requires a physical device with a print service (Print Spooler); cannot be verified statically.

---

### 3.3 Issue 2 — "Pull-to-refresh indicator gets stuck" — **[C] (cause confirmed; still live in the working tree)**

**Exact sources (working tree, where the feature was introduced):**
- `EmployeeAppViewModel.kt:225-227` — `isRefreshingQuarries/isRefreshingContent/isRefreshingTrash` in `EmployeeAppUiState`.
- `EmployeeAppViewModel.kt:657-697` (`refreshQuarries`), `699-771` (`refreshQuarryContent`), `773-816` (`refreshTrash`); pattern:

  ```kotlin
  fun refreshQuarries() {
      if (_uiState.value.isRefreshingQuarries) return
      viewModelScope.launch {
          _uiState.update { it.copy(isRefreshingQuarries = true) }
          try { … repository call … } finally {
              _uiState.update { it.copy(isRefreshingQuarries = false) }
          }
      }
  }
  ```
- `HomeScreen.kt:158-164`, `QuarryDetailScreen.kt:229-235`, `TrashScreen.kt:89-90` — `PullToRefreshBox(isRefreshing = uiState.isRefreshing…, onRefresh = …)`.
- `android/gradle/libs.versions.toml:12` — `composeBom = "2024.10.01"` → material3 **1.3.0**.

**Root cause (confirmed mechanism, all conditions code-derived; the library behavior is externally documented):**

`refreshQuarries()` has **zero guaranteed suspension between `_uiState.update { … = true }` and the `finally` reset**. Worst-case instant paths exist in `EmployeeRepository.executeWithTokenRenewal` (`EmployeeRepository.kt:127-192`):

- No stored access token → `resolveToken() ?: return ApiResult.Error(401, "No authentication token available")` (`:131-132`) — **completes without a single suspension**; the set-true and finally-reset then both execute inside one dispatcher task.
- Instantaneous network failure (DNS/proxy refusal) → `executeRequest` returns a mapped result without suspending beyond the `withContext(Dispatchers.IO)` hop.
- Debug-build backend `http://192.168.1.8:8000` (LAN, `android/app/build.gradle.kts` debug config) routinely answers within a few milliseconds — **less than one 60 Hz frame (16.7 ms)**.

When the `isRefreshing` parameter goes `true → false` faster than one frame, Compose coalesces the intermediate `true` and material3 1.3.0's `PullToRefreshBox` never observes the true→false transition it needs after the gesture released past the threshold — the documented "indicator gets completely stuck and will not leave the screen" behavior (with the mechanism explained: intermediate sub-frame updates are skipped by the frame pipeline; fixed upstream only in **material3 1.4.0-alpha01**). The project's BOM predates that fix.

Supporting evidence: the company-admin content refresh performs **two sequential network calls** (`getFolders` + `getDocuments`, `EmployeeAppViewModel.kt:704-709`) — the stuck behavior is therefore systematic on fast-error paths (e.g., cold token) and common on LAN-success paths, where the entire success branch (JSON parse + notification state write) adds only a few milliseconds on top of the sub-frame response.

**What is *not* the cause (checked):** the ViewModel's `finally` always runs (including on coroutine cancellation), so the flag cannot wedge `true` permanently at the VM level; the guard `if (…isRefreshing…) return` is benign (double-tap-safe); no other writer of these flags exists.

**Expected vs actual:** expected — indicator appears during refresh and hides immediately (one settle animation) after completion; actual (fast paths) — released pull leaves the indicator on screen until the next successful slow refresh or process restart.

**Minimal fix (choose one; both preserve behavior elsewhere):**
1. **Preferred:** bump `composeBom` to a version carrying material3 ≥ 1.4.0-alpha01 (post-fix `PullToRefreshBox`) — one line in `libs.versions.toml`; re-verify screens using other BOM-sensitive APIs (`searchbar`, `pulltorefresh` package layout unchanged).
2. **Fallback without dependency change:** guarantee ≥ 1 frame of visible `true` by making the reset asynchronous-by-design, e.g., in each of the three refresh functions move `_uiState.update { … = false }` after a short minimum-display hold (`kotlinx.coroutines.delay(150)`) placed **inside the `try`/`finally` after the network result is processed**, and set `true` before any result processing (tests continue to pass because `StandardTestDispatcher`/`advanceUntilIdle` consume the virtual delay). Also acceptable: switch the three screens to `RememberedPullToRefreshState`-style explicit `startRefresh()/endRefresh()` driving.

Whichever is chosen, apply to all three refresh functions (`refreshTrash`/`refreshQuarryContent` have the same shape) and keep the per-surface flags separate (do not unify into one `isAnyRefreshing` — it would break independent surfacing).

**Regression tests required:** a Compose UI (instrumented or Robolectric) test that completes a fake-fast refresh within a single frame and asserts the indicator disappears — this is the only test class that can catch this class of frame-coalescing bug; the existing limitation is that no instrumented test module exists today. In unit space, add a refresh-function test asserting flag sequencing through both transitions, with the acknowledged limitation that a ViewModel-only test can only assert flag sequencing, which already passes.

**Cross-feature impact:** BOM bump touches every Compose surface (Home/Detail/Trash/Scanner/Updates) — requires full smoke of the five flows after bump; the delay fallback touches only the three refresh functions and is inert to slow networks.

---

### 3.4 Issue 1 — "Create Quarry fields do not accept input" — **[H] with one confirmed contributor; otherwise not reproduced in obtainable code**

**Exact sources (working tree):**
- Dialog: `HomeScreen.kt:352-473` — `AlertDialog` with three controlled fields:

  ```kotlin
  OutlinedTextField(value = uiState.newQuarryName,  onValueChange = onNewQuarryNameChange,  enabled = !uiState.isCreatingQuarry, …)
  OutlinedTextField(value = uiState.newQuarryNumber, onValueChange = onNewQuarryNumberChange, enabled = !uiState.isCreatingQuarry, …)   // :395-409
  OutlinedTextField(value = uiState.newQuarryType,  onValueChange = onNewQuarryTypeChange,  enabled = !uiState.isCreatingQuarry, …)   // :411-432
  ```
- Wiring: `EmployeeAppScreen.kt:181-184` — `viewModel.onNewQuarryNameChanged / Number / Type / createQuarry()`.
- Handlers: `EmployeeAppViewModel.kt:1190-1225` (`openCreateQuarryDialog/reset/handlers`), `:1227-1315` (`createQuarry`).

**What was checked and is NOT broken (confirmed):**
- `onValueChange` callbacks are wired to the correct ViewModel handlers; the handlers update exactly the matching field via atomic `_uiState.update {}` (which cannot lose concurrent keystrokes).
- No composable resets the dialog's fields during recomposition (fields are re-set only from `openCreateQuarryDialog()` and the post-success branch).
- No full-screen overlay/starvation path replaces the dialog's window; `FloatingNotificationHost` (`EmployeeAppScreen.kt:198-203`) is a toast, composite at `BottomCenter`, not focus-grabbing.
- Navigation/async init does not overwrite the form: `loadQuarries()` updates only `quarries`; `fetchProfile` updates only auth/profile fields; `MutableStateFlow.copy` preserves sibling fields.
- The Create button's enable condition (`HomeScreen.kt:446-448`) matches all three non-blank fields; the keyboard `onDone` action (`:425-431`) mirrors it.

**Confirmed contributor [C]:** `enabled = !uiState.isCreatingQuarry` on all three fields with **no inline progress surface** inside the dialog body (only a 16 dp spinner inside the confirm button, `HomeScreen.kt:450-457`). `createQuarry()` (`EmployeeAppViewModel.kt:1243-1245`) sets `isCreatingQuarry = true` **before** the repository call; against a cold/unreachable server the request schedules per OkHttp timeouts (`QuarryVaultApiClient.kt:76-82`: connect 15 s, read/write 30 s — up to ~45 s worst case with token renew retry). During that entire window every field is dead to the keyboard with no explanation. A user attempting to type inside that window experiences exactly "typing does nothing / fields do not accept input". Additionally:

- The disabled state has no per-field "processing" affordance; complaints are attributed to the input, not the network.
- `openCreateQuarryDialog()` (`:1190-1200`) does **not** reset `isCreatingQuarry = false`. All three result branches of `createQuarry()` do reset it (`:1251, 1299, 1308`), so a permanent wedge is not reachable through any modeled code path (the repository layer maps every exception into an `ApiResult`— `QuarryVaultApiClient.executeRequest` `:795-822` catches `Exception`; identity refresh failures map to results). A belt-and-braces reset in `openCreateQuarryDialog` is nevertheless recommended (see remediation).
- `createQuarry()` lacks a `try/catch` around the repository call (contrast `refreshQuarries`/`downloadDocument` which have `try/finally`). Nothing in the reachable code throws today, but this is the one structurally-fragile point: any future throwing change would permanently strand `isCreatingQuarry = true` AND thereby disable the dialog (fields + buttons) — a latent failure mode shape-identical to the reported symptom. (ViewModel-scope cancellation happens only at VM clear, where state is recreated, so it cannot produce a visible wedge in the current architecture.)

**Reassessment of the shipped APP:** At HEAD (2026-10-27) the dialog had a *single* controlled field (HEAD `HomeScreen.kt` lines 302-370, retrievable via `git show HEAD:android/app/src/main/java/com/quarryvault/employee/ui/screens/HomeScreen.kt`) wired identically — per source, also sound. Therefore the original symptom presumably occurred in (a) the 15–45 s disabled window, (b) a device-specific IME/interaction, or (c) an intermediate build snapshot not preserved anywhere in the repo. (c) cannot be excluded because the shipped `Al-Manzouma.apk` (10/29 16:11) was built from a working-tree state that no longer exists and was never committed; logically the "Critical Bug Fixes Regression Suite" header documents that a field-input bug was previously known and repaired — its original shape is unrecoverable here.

**Expected vs actual (current tree):** expected — fields always accept typed text except while an in-flight create is genuinely running, and while disabled they say so; actual — they disable silently for the full network timeout with no UI explanation, and the Create attempt is retriable only via one spinner dot.

**Minimal fixes (small, testable):**
1. Make `isCreatingQuarry` visible inside the dialog body: replace the `disabled` look with `supportingText` (or a small `LinearProgressIndicator`) explaining "جاري الإنشاء…" — UI-only change in `HomeScreen.kt:367-441`.
2. Defensive state hygiene: add `isCreatingQuarry = false` to `openCreateQuarryDialog`'s reset and wrap the `repository.createQuarry(...)` call in `try/catch { reset flag + error message }` in `createQuarry()` — two-line change, no behavior shift on the happy path.
3. Do **not** remove the `enabled = !uiState.isCreatingQuarry` guard (it prevents double-submit storms while the network retries token-refresh storms internally).

**Regression tests required:** extend `EmployeeAppViewModelTest.createQuarry_*` with (a) an exception-throwing `FakeEmployeeRepository.createQuarry` asserting the flag resets and an error surfaces (guards fix #2), (b) `openCreateQuarryDialog()` clearing the flag mid-flight, (c) keep existing "accept input and reset cleanly" test (line 757). An instrumented keyboard test is desirable but optional.

**Environment limits:** the definitive confirmation requires installing the current build (versionCode 33) on the affected device and typing with the target keyboard (Arabic IME) — not possible in this read-only session; uncommitted-nature also means the tree can drift before verification.

---

### 3.5 Issue 5 — "Create Quarry screen briefly renders LTR before RTL" — **[C] structural / [H] the exact flashed frame**

**Exact sources:**
- `MainActivity.kt:23` (added in the uncommitted fix): `window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL` — unconditional, no locale basis.
- `HomeScreen.kt:51-54` — direction chosen from `uiState.isArabic` and provided compositely:
  ```kotlin
  val isAr = uiState.isArabic
  val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr
  CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) { Scaffold(…) }
  ```
  (`EmployeeAppScreen.kt:35-38`, `QuarryDetailScreen.kt:67-68`, `TrashScreen.kt` follow the same pattern — four independent copies.)
- Dialog: `HomeScreen.kt:353-354` + per-slot wrappers at `:360, 368, 445, 463` — `AlertDialog` wrapped and, additionally, each of `title/text/confirmButton/dismissButton` individually re-wrapped.
- Dialog windows: created by M3 `AlertDialog`; the materialized dialog window's `decorView` resolves direction from **the configuration/locale** (typical target devices: English locale → LTR), not from the activity's programmatically overridden `decorView`.
- HEAD baseline (committed): `MainActivity` had **no** such override at all and `isArabic = false` was the `EmployeeAppUiState` default with an in-app `toggleLanguage()` (HEAD `EmployeeAppViewModel.kt:76, 172`; `HomeScreen.kt:32, 62`). I.e., at HEAD, on an English-locale device the app **started LTR** and flipped to RTL only via the toggle — user reports of "renders LTR before RTL" match the state machine at HEAD for the whole app, and match the *dialog-window* mismatch in the current tree.

**Root cause (structural, confirmed):** Three direction authorities disagree —
1. Runtime-forced activity-window direction (RTL),
2. Configuration-derived dialog-window direction (LTR on English-locale devices),
3. Composition-local providers applied per screen/per dialog slot (RTL when `isArabic`).

On dialog presentation the platform window backs the content with LTR-derived defaults; the in-compose providers then paint the content RTL. The observable "briefly LTR, then RTL" is the first dialog frame under (2) before (3) reconciles the tree — the uncommitted fix's per-slot provider wrappers are the recognizable symptom-patch for this mismatch. The frame-precise ordering (window backdrop vs compose content) is the [H] remainder; the existence of two disagreeing authorities is not.

**Expected vs actual:** expected — Arabic UI composes RTL from the first frame, always, in activity windows and dialog windows alike, with an English option available; actual — direction depends on which authority wins per window-type per frame (dialog flash; HEAD-version start-in-LTR).

**Minimal fix (preserves English support; no API upgrades needed):**
1. Stop hand-stitching view direction. Persist a language preference (e.g., `SharedPreferences` "app_locale", default `ar`), resolve once in `MainActivity.attachBaseContext` and apply via `createConfigurationContext`/`applyOverrideConfiguration` with `setLocales(LocaleList.forLanguageTags(prefsLocale))`. This single source drives the activity window **and every dialog window** (dialogs inherit the activity's configuration), making window decoration and content direction consistent by construction. Provide a user-facing language option (the HEAD toggle can be restored as a menu item; toggling writes the preference and calls `recreate()` — same visual contract as an app-language switch).
2. Then remove the now-redundant per-slot `CompositionLocalProvider` wrappers in `HomeScreen.kt` (keep one top-level provider only if some screen still needs an explicit override during transition), and remove `window.decorView.layoutDirection = LAYOUT_DIRECTION_RTL` from `MainActivity.onCreate` — otherwise the forced override would fight the new per-app-locale configuration for English users (English support requires the forced line to be neutral or removed).
3. Keep `uiState.isArabic` for *content-string polarity* (bilingual strings are hardcoded, no resource files): it should be sourced from the persisted preference at VM construction rather than crafted independently.

**Regression tests required:** ViewModel-level — `isArabic` sourced from storage (a storage-backed default test); instrumented/UI — dialog opens with RTL on first frame with Arabic app-locale and LTR with English (this is precisely the assertion class that requires a Compose UI test on an emulator; today the project has none, so keep manual acceptance otherwise). Existing tests unaffected (they do not assert direction).

**Cross-feature impact:** every screen (bilingual strings gated on `isArabic`; `UiFormatters` date/number formatting), the language toggle restored as a feature, and any future resource-based localization. The risk is contained because resource localization surface is tiny — `res/values/strings.xml` holds only `app_name` (`android/app/src/main/res/values/strings.xml`), no `values-*` locale variants exist, and in-code bilingual strings are the only localized content — so direction is effectively the only config-dependent visual property.

**Environment limits:** the flash is only observable on-device (frame-level), and dialog-window direction behavior can differ across OEM flash builds; the structural audit is complete, the frame accounting is labeled [H].

---

## 4. Phase 3 — Clean-code assessment (scoped, no rewrites)

The five bugs produced a compact set of structural observations — each with the **smallest maintainable correction**, because the files involved are already 2.9k lines (`EmployeeAppViewModel.kt`) and any wholesale rewrite is out of scope:

| # | Observation | Files | Smallest maintainable design |
| --- | --- | --- | --- |
| 1 | **One state per user intent is now correct** — the previous single-`downloadedDocumentData` model caused Issues 3/4. Guard against regression by keeping the three separate fields + dedicated clear methods (already separated). | `EmployeeAppViewModel.kt:187-189, 1703-1988`, `QuarryDetailScreen.kt:107-131` | Keep as-is; do not reintroduce any "payload union" state. Document the invariant in the UIData class docblock. |
| 2 | **Dead parameter + unreachable code** — `onDownloadDocumentToUri` (`QuarryDetailScreen.kt:59`; `EmployeeAppViewModel.downloadDocumentToUri` `:1771-1864`) duplicates the download path and, if ever wired, would double-save (state write after direct write). | `QuarryDetailScreen.kt:59`, `EmployeeAppViewModel.kt:1771-1864` | Delete the parameter and the function (or wire it as an actual SAF flow and **remove** its `downloadedDocumentData` write after a direct URI write). |
| 3 | **Per-slot `CompositionLocalProvider` wrappers ×4 files** are the visible patch layer of Issue 5. | `MainActivity.kt:23`, `HomeScreen.kt:54/354/360/368/445/463`, `EmployeeAppScreen.kt:38`, `QuarryDetailScreen.kt:133` | One configuration-derived direction (§3.5 fix), then collapse wrappers to at most one per screen. |
| 4 | **Busy-override feedback lives inside the trigger button only** (`CircularProgressIndicator` at `HomeScreen.kt:450-457`) — the direct UX driver of Issue 1's symptom class. | `HomeScreen.kt:367-441` | Inline `supportingText`/progress row in the dialog body; keep the enable-guard (§3.4). |
| 5 | **Refresh state machine duplicated ×3** with identical `finally` semantics (the Issue-2 fix would otherwise target three places). | `EmployeeAppViewModel.kt:657-816` | Extract one private suspend helper owning the "set true → work → minimum-display hold → reset false" sequence so the frame-gap fix lands in one place. Not a rewrite: ~20 lines. |
| 6 | **`createQuarry()` lacks `try/finally`** around the repository call (refresh/download/print siblings have it). | `EmployeeAppViewModel.kt:1243-1315` | Wrap in `try/catch` with flag reset (§3.4 fix #2). |
| 7 | **Bilingual strings inverted through `if (isAr)` × hundreds of sites** — unchanged shape, not causal here, but it is the content-polarity coupling that made locale work fragile. | all screens | do-not-touch in this phase; a future localization pass belongs in Phase F of the prior audit plan. |
| 8 | **Oversized ViewModel ownership remains** (multi-feature state in one class: auth + quarry + documents + scanner + updates + employees). This audit did not expand it, only noted the *document-actions* region (Issues 3/4) is the natural first extraction: a small `DocumentActionsState` owner (three pending payloads + clear methods + single fetch routine) would fit ≤ 150 lines and would have made the Issue-3/4 bug shape impossible. | `EmployeeAppViewModel.kt` | Defer to Phase D per the prior audit; extract `DocumentActionsState` first when that phase starts. |

No contention: this tree's constructs are recognizable, and the fixes are surgical. The remaining "duplicated-representation" concerns in the backend (membership vs legacy permissions QV-005; computed vs stored quota) are re-listed unchanged in §7.

---

## 5. Phase 4 — Independent re-verification of prior findings

| ID | Prior claim | Verified status | Evidence re-checked now |
| --- | --- | --- | --- |
| **QV-001** | `POST /quarries` lacks company-admin/quarry-permission guard | **STANDS — confirmed** | `backend/src/modules/quarries/router.ts:186` — `quarriesRouter.post('/quarries', authenticate, async …)`; handler validates fields, blocks duplicate name/number (regex as above, lines 203-217), creates `QuarryModel` **and 8 standard folders** (`:219-235`), with no `requireCompanyAdmin`/`requireQuarryPermission`. Contrast PATCH `:264-267` and DELETE `:335-338` which require `requireCompanyAdmin`. Important nuance: the Android client (`EmployeeAppScreen.kt:179`, `HomeScreen.kt:140-146`) exposes Create Quarry to **any signed-in employee** and maps 403 (`createQuarry_forbidden_setsPermissionError` test), so customer-facing behavior is consistent with "employees may create" — the guard decision is a **product-policy question**, not an accidental omission on the client side. The **server-side open-door** remains confirmed. |
| **QV-002** | Android session key from a hard-coded salt; fail-open plaintext | **STANDS — untouched by the fix attempt** | `android/.../data/session/SessionStorage.kt:111-115` (`deriveKey` = SHA-256 of `"quarryvault_secure_keystore_salt"`), `:117-130` / `:132-144` (`catch(_: Exception) { plainText }` in both `encrypt` and `decrypt`). No Keystore integration exists in the file. The uncommitted changes to this file touched only unrelated session fields. |
| **QV-003** | Platform admin customer-content access needs only `X-Company-Id` + audit | **STANDS — confirmed** | `backend/src/middleware/auth.ts:258-357`: cross-office path resolves `PlatformAdminModel`, blocks suspended-company mutations, then creates a **synthetic membership** (`company_admin`, `:338-345`) and audits `platform.cross_office_context_grant`. Content-level decision in `backend/src/modules/documents/router.ts:97-207` (platform-admin branch with `platform.cross_office_content_access` audit). Test file `backend/tests/security_authorization.test.ts:26-81` codifies header-only access with audit. No support-grant entity anywhere (repo-wide grep for "support grant"/lifecycle fields — none). |
| **QV-004** | Backend test setup is destructive | **STANDS — refined** | `backend/tests/setup.ts:7-15` (documented above): memory-server fallback softens the *unreachable* case, but for any reachable `TEST_MONGODB_URI`/default localhost the destructive `deleteMany({})` (`:26-33`) runs without asserting `*test*`-shaped isolation. Not run. |
| **QV-005** | Dual permission authorities with legacy precedence | **STANDS — confirmed** | Schemas: `backend/src/database/models/index.ts:75-92` (Membership flags + `hidden_quarries`) and `:134-149` (legacy `QuarryPermission` flags, unique `(user_id, quarry_id)`). Precedence: `backend/src/middleware/auth.ts:622-655` — legacy row **overrides membership** when defined (`:645-649`). |
| **QV-008** | Upload non-atomic across Mongo/storage/quota/sync/audit | **STANDS — confirmed** | `backend/src/modules/documents/service.ts:183-264`: quota reserve + storage put + mark-available + idempotency complete + sync append + audit; catch path deletes doc/releases quota/**best-effort** storage delete (`.catch(() => {})` `:257`) and marks idempotency failed. No transaction/outbox. Setup code also matches the prior audit's mapped step list (reserved→pending→uploaded→available). |

None of the six findings required correction of its substance; QV-001 additionally gains the nuance that the *client product* currently assumes employee creation is legitimate — the backend guard change should be staged with a simultaneous product decision (either hide the Create Quarry FAB for non-admins in the app, `HomeScreen.kt:140-146,273-283`, and respectively in the employee-management flow, or explicitly ratify employee creation).

---

## 6. Prioritized implementation plan (for the next coding sessions)

Verified-invariant framing: every step below is labeled by the feature areas it can affect, and none requires restoring Supabase, diagnostics screens, manual token entry, or weakening any auth/tenancy/file check.

**P0 — Protect the current state (prerequisite, minutes):**
1. Commit the uncommitted fix attempt as-is (or to a branch) — it is the working solve for Issues 3/4 and partially 1/5; nothing else must run over it. *Affects: everything downstream (git history only).*

**P1 — Definite defect with a confirmed still-live mechanism:**
2. **Issue 2 stuck refresh:** apply the frame-gap fix (BOM bump ≥ material3 1.4.0-alpha01 preferred; per-refresh minimum-display fallback otherwise — extract the shared helper first if applying manually, §4 item 5). *Affects: Home/Detail/Trash refresh surfaces; BOM option touches all Compose screens → full smoke of the five flows after.*
3. **Issue 5 direction unification:** implement preference + `attachBaseContext` locale with default `ar`, add the language option (pref toggle + `recreate()`), then remove the forced `decorView.layoutDirection` line and collapse per-slot providers. *Affects: every screen's text polarity (`isArabic`), keyboard/input experience, date formatting (`UiFormatters`) — golden paths: login → home → detail → dialogs → scanner.*

**P2 — Confirmed UX/robustness gaps:**
4. **Issue 1 hardening:** dialog-body progress affordance; `openCreateQuarryDialog` flag reset; `try/catch` around `repository.createQuarry`; then on-device verify typing with Arabic IME on the 33 build. *Affects: create-quarry dialog only.*
5. **Issue 3/4 residuales:** remove the dead `downloadDocumentToUri`/`onDownloadDocumentToUri` (or correctly wire SAF and remove its post-write state assignment); handle the API-26–28 download path (add `WRITE_EXTERNAL_STORAGE` (maxSdk 28) + runtime request, or reject with a clear message on < Q). *Affects: document list menus; trash/scanner flows unaffected.*

**P3 — Backend (prior cases stand; order from prior audit preserved, refined):**
6. **QV-004 first** (safe-testing gate): require explicit disposable `TEST_MONGODB_URI` + fail closed if the URI's database name is not `*test*`-shaped; keep memory-server fallback only when the env var is absent. This must land before any scheduled test runs happen. *Affects: backend test suite only.*
7. **QV-001:** ratify product policy; add the chosen guard to `POST /quarries` + role-matrix tests including the 8-folder side effect; align Android FAB visibility only after policy. *Affects: quarry management, Android Home surface, admin dashboard copy.*
8. **QV-003:** introduce a `SupportGrant` lifecycle (purpose/scope/expiry/revocation/actor+approver) checked before content access; keep `platform.cross_office_content_access` audit keys for compatibility. *Affects: platform admin dashboard, documents router, sync endpoints; requires a policy feature before code.*
9. **QV-005:** consolidate permission authority — migrate legacy records with verified data reconciliation, route writes to the single authority with deny-safe semantics; keep audit keys. *Affects: employees/quarries permissions flows + Android EmployeeManagementScreen toggles.*
10. **QV-008:** add an upload reconciliation job (find `pending` documents with mismatched storage refs, orphaned storage objects, stranded quota) plus fault-injection tests in the isolated suite. *Affects: upload pipeline, quota, trash/purge.*

**P4 — Maintenance:** commit hygiene (fix attempt + report), README/docs corrections (QV-007), then extract `DocumentActionsState` (§4 item 8) when Phase D begins.

---

## 7. Remaining unknowns and limitations

- Issue 1 and the Issue-5 flash require **on-device** confirmation with the versionCode-33 build (typed Arabic IME, dialog first frame); static analysis refutes/limits both but cannot prove either absent.
- The intermediate working-tree states between 10/27 (commit) and 10/30 (edits) are unrecoverable; the exact snapshot that produced the originally reported symptoms (including which intermediate build the user saw) cannot be reconstructed.
- No backend tests, no gradle builds, no instrumented tests were executed; compile-correctness of the uncommitted fix attempt + test additions has not been compiler-verified.
- Whether the user's installed build is `Al-Manzouma.apk` (10/29) or a newer debug/release built 10/30 is unknown; the fix-attempt story above assumes the former for the original symptom report.
- Backend data was not touched; live `.env` were not read; no runtime reachability tested; QV-003's *product* need for support-grants remains an audit-driven requirement (as noted in the prior audit), not an independently sourced written standard.

---

## Final status — per symptom

| Issue | Status | Cause type |
| --- | --- | --- |
| 1. Create Quarry input | **PARTIALLY CONFIRMED** | Confirmed contributor: silent disabled window during create attempts (up to ~45 s) + missing exception-safety; original symptom's exact code shape unrecoverable; must be re-verified on the current build. |
| 2. Pull-to-refresh stuck | **CONFIRMED** | Sub-frame `true→false` coalescing + material3 1.3.0 `PullToRefreshBox` stuck-indicator defect (fixed upstream ≥ 1.4.0-alpha01; BOM pins 1.3.0). Live in the current tree. |
| 3. Download → preview | **CONFIRMED (at shipped HEAD)** | Single shared action state + unconditional `openDocument` on completion; no save-to-device path existed. Fix present in uncommitted tree (verified by reading; needs device + suite run). |
| 4. Print → preview | **CONFIRMED (at shipped HEAD)** | Shared action handler + explicit `printDocument` fallback to `openDocument` for non-PDF. Fix present; PrintManager now used for PDF/image; explicit refusal toast for other formats. |
| 5. LTR flash → RTL | **CONFIRMED structural / flash-frame HYPOTHESIS** | Three disagreeing direction authorities (forced activity-window RTL, configuration-derived LTR dialog windows, composition-local providers); the fix attempt's per-slot wrappers are the patch. Home-render-order detail needs the device. |

**ROOT CAUSES PARTIALLY CONFIRMED** — Issues 2, 3, 4: fully confirmed with exact functions and lines; Issue 5: structural cause confirmed, frame-order detail pending device confirmation; Issue 1: no silent-typing-drop mechanism exists in obtainable code, confirmed busy-disable contributor only, exact original symptom needs device reproduction; QV-001/002/003/004/005/008 all re-verified and standing (QV-004 softened by the memory-server fallback in the specific unreachable-default case, unchanged otherwise).

---

# Re-review #2 — evening 2026-10-30, against the developer's own follow-up edits

Requested by the developer ("re-review, I edited a lot myself") after Re-review #1 was written (report mtime 18:52). This section re-verifies every Android issue and every open QV finding against the tree **as of ~19:25**, and — for the first time — **executes the safe test suites** (backend only; the Android suite is compile-blocked).

## R2.0 Evidence timeline (why line numbers may have shifted between self-edits)

| Time (Oct 30) | Event |
| --- | --- |
| 18:13 | `release/app-release-unsigned.apk` built (2.7 MB, versionCode 31→32) |
| 18:38–18:46 | Android edits: `EmployeeAppScreen`, `HomeScreen`, `QuarryDetailScreen`, `DocumentActionsHelper`, `EmployeeAppViewModel`, `EmployeeAppViewModelTest` |
| 18:46:51 | `version.properties` → `version.code=34`; `debug/app-debug.apk` (19.3 MB) written 18:47 |
| 18:52 | Re-review #1 report finalized |
| 19:09–19:14 | Backend edits: `disasterRecovery.ts`, `models/index.ts`, `auth.ts`, `documents/router.ts`, `platform/router.ts`, `quarries/router.ts`, `supportGrants.ts` (new), `types/index.ts`, `tests/setup.ts`, `security_authorization.test.ts`, `disaster_recovery_drill.test.ts` |
| 19:16:56 | `SessionStorage.kt` rewritten (QV-002 Keystore work, in progress at review time) |
| 19:16–19:19 | Backend suites executed by the reviewer (see §R2.5) |

Note: `version.code` is incremented on the *request* for an APK task (`app/build.gradle.kts:21-31,66-73`), before compilation, so code=34 does not by itself prove the build succeeded — the two SKD APKs in `build/outputs` are the success evidence and both predate the 19:16 `SessionStorage` rewrite.

## R2.1 BLOCKING: the Android tree does not compile

```
e: .../data/session/SessionStorage.kt:7:22 Unresolved reference 'KeyGenerator'.
e: .../data/session/SessionStorage.kt:71:25 Unresolved reference 'KeyGenerator'.
```

Root cause (one line): `SessionStorage.kt:7` imports `java.security.KeyGenerator`; that class does not exist. The correct package for the AES generator used at line 71 is:

```kotlin
// SessionStorage.kt, line 7 — replace
import java.security.KeyGenerator
// with
import javax.crypto.KeyGenerator
```

Everything else in the new code (AndroidKeyStore provider at `:62-88`, `SessionCipher` legacy→v2 migration at `:96-153`, fail-closed `readEncrypted` that clears the session instead of returning plaintext at `:203-218`) reads as a coherent, testable QV-002 design, and `SessionStorageTest.kt` already carries five tests matched to it (round-trip with `QV2:` prefix, legacy migration, plaintext/corrupt rejection, keystore-unavailability fail-closed). Consequence: `:app:testDebugUnitTest` could not be executed in this review; nothing about the new session storage has been verified at runtime yet.

By contrast, the APK actually built at 18:47 (and any APK distributed so far) still contains the **old** storage: hard-coded salt + fail-open plaintext — i.e. **QV-002 still ships today**; the Keystore rewrite has not shipped and is not verified.

## R2.2 Android issues — re-verified line by line

**Issue 1 (Create Quarry) — improved, residual remains.** The dialog now shows an inline 16 dp `CircularProgressIndicator` inside the confirm button while `isCreatingQuarry` (`HomeScreen.kt:450-457`), confirm is gated (`:448`), cancel disabled during the call (`:466`), outside-tap/back-fire path suppressed while busy (`:357`), and all three fields disabled while busy (`:386,402,418`). Two residuals are unchanged: `createQuarry()` still has **no try/catch** (`EmployeeAppViewModel.kt:1248-1336`) — an exception escaping the repository seam would leave the flag stuck for the process lifetime (low likelihood because `QuarryVaultApiClient` catches broadly into `ApiResult.NetworkError`, but the seam is not exception-safe by construction); and `openCreateQuarryDialog()` still does **not** reset `isCreatingQuarry` (`:1211-1221`). Symptom (silent typing drop) still awaits device confirmation on the current build.

**Issue 2 (Pull-to-refresh stuck) — STILL LIVE, cause unchanged.** `libs.versions.toml` still pins `composeBom = "2024.10.01"` → material3 1.3.0 (the fixed release is material3 ≥ 1.4.0-alpha01; only material3 is affected, and a per-library override `androidx.material3:material3` would avoid unrelated BOM changes). All three refresh funnels remain `true→false` with **no guaranteed suspension or minimum frame gap**: `refreshQuarries` (`:658-708`), `refreshQuarryContent` (`:710-792`), `refreshTrash` (`:794-836`). The suspension-free fast path in `executeWithTokenRenewal` (`EmployeeRepository.kt:131-137`, `return ApiResult.Error(401, ...)` before any I/O) remains the no-frame trigger. The new split flags (`isRefreshingQuarries/Content/Trash`, `:226-228`) are a real improvement for screen-switch edge cases but do not fix sub-frame coalescing. New observation: `refreshTrash` has `finally` but **no catch** (`:797-836`) — unlike the other two refreshes; its blast radius is currently small only because the repository seam converts exceptions, but the function is not exception-safe by construction.

**Issues 3 & 4 (download/print → preview) — fix intact at current tree, improved during 18:38-18:46 edits.** Three-state payloads with three independent `LaunchedEffect`s (`QuarryDetailScreen.kt:107-131`); ViewModel functions reset flags in `finally` and support content-disposition filename takeover (`EmployeeAppViewModel.kt:1724-1790 / 1887-1947 / 1949+`; filename logic covered by three ViewModel tests). `DocumentActionsHelper.printDocument` now: PDF → PrintManager adapter (`:155-192`), image → bitmap→PDF page adapter (`:193-241`), other formats → explanatory refusal toast (`:242-248`) — the old unconditional `openDocument` fallback is gone (`:117-139` remains exclusively for View). `saveDocumentToDownloads` uses `MediaStore.Downloads` with entry-cleanup on failure (`:44-63`) and a legacy `<Q` branch (`:71-101`). Residual dead code, unchanged: `EmployeeAppViewModel.downloadDocumentToUri` (`:1792-1886`) and the `onDownloadDocumentToUri` parameter (`QuarryDetailScreen.kt:59`) still have **no call sites** — delete them. A secondary pre-Q gap persists: the manifest still does not declare `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion=28`), so the `<Q` branch cannot succeed on API ≤ 28 devices; targetSdk 35 makes devices below that unlikely, but the branch is dead-on-arrival code as shipped.

**Issue 5 (LTR flash → RTL) — structure unchanged, still live.** `MainActivity.kt:23` still forces `window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL`; `HomeScreen.kt` still derives `layoutDirection` from the device *configuration* (`:52`) and wraps both the screen (`:54`) and **each slot individually** in `AlertDialog` (`:354,360,368,445,463`). The 18:38 edits did not unify direction authority. The three-authority conflict (activity window pulled RTL; configuration-derived; per-slot overrides) remains the confirmed structural cause; the device-flash-frame detail remains unverified.

## R2.3 Backend findings — re-verified after the 19:09–19:14 edit wave

**QV-001 — FIX NOW PRESENT IN CODE (and exercised by tests).** `POST /quarries` no longer relies on `authenticate` alone. The handler itself now enforces: `company_admin` passes always; otherwise an employee must hold a **same-company** membership with `can_upload === true` (`backend/src/modules/quarries/router.ts:186-209`); denials are audited (`quarry.create`, `AuditResult.denied`) and rejected with a `ForbiddenError`. The duplicate name/number regex checks and the 8-standard-folders side effect are unchanged (`:210-260`). Covered positively by `security_authorization.test.ts` "2. Quarry Creation Authorization" (run below).

**QV-002 — previously standing; now WIP-REWRITTEN in tree (see §R2.1: good design, one-line compile blocker, zero runtime verification, not yet shipped in any APK).**

**QV-003 — FIX NOW PRESENT IN CODE (and exercised by tests).** A real `SupportGrant` lifecycle now exists:
- Model: `backend/src/database/models/index.ts:111-133` (`SupportGrant`, status enum defaulting `pending`, `scopes[]`, company/platform-admin/requestor/approver fields, index on `company_id+status+expires_at`).
- Scope mapper: `backend/src/services/supportGrants.ts:5-22` — GET document download → `document_download`; GET list/metadata of quarries/folders/documents/trash/versions → `document_metadata_read`; **anything else → deniable (null)**.
- Gate: `backend/src/middleware/auth.ts:296-362` — out-of-scope requests are audited `platform.support_grant.denied` and rejected 403; a grant must be `active`, matched to scope, and `findActiveSupportGrant` enforces **four-eyes separation** (`approved_by_platform_admin_id: { $ne: platformAdminId }`), non-null `approved_at`, ≥ future `expires_at` within a 1-hour ceiling, `revoked_at: null` (`:24-40`); usage is audited `platform.support_grant.used`; only then is the synthetic membership created (`:313-396`, now carrying `supportGrantId`).
- Covers all 12 tests in `security_authorization.test.ts`.

**The cost: five Stale tests now fail deliberately.** The old suites codify the era of header-only cross-office access; the new policy results in 403 where they anticipated 404/200/204. Table:

| Stale test (file → case) | Expected | Current | Reason |
| --- | --- | --- | --- |
| `e2e_runtime_verification.test.ts` 6.2 — mismatched X-Company-Id | 404 | 403 | Grant check now happens before document resolution |
| `stabilization_verification.test.ts` 2.2 / 2.3 — platform-admin download w/o grant / mismatched company | 404 | 403 | ditto |
| `user_management_and_storage.test.ts` 6 — platform admin cross-access | 200 | 403 | No SupportGrant seeded |
| `preproduction_overhaul.test.ts` 5 — platform admin deletes a standard folder | 204 | 403 | Folder **deletion** is deliberately outside `document_metadata_read`/`document_download` scope |

These are not regressions; they are the old policy's executors. They must be updated to seed a grant (or assert 403) — the fix should also decide whether the platform folder-deletion capability should become a dedicated grant scope.

**QV-004 — FIX NOW PRESENT IN CODE, verified by execution.** `backend/tests/setup.ts:7-13` now **throws** when `TEST_MONGODB_URI` is set and unconditionally connects `MongoMemoryServer` (`uri db quarryvault_test`); `evaluate` vitest config: `fileParallelism: false`, setup file is the only connection point (grep confirms no other `mongoose.connect` in tests). The destructive `deleteMany({})` remains in `beforeEach` `:22-28` — but it can only ever run against the in-memory instance. This closes the "reachable configured URI" hole from Re-review #1; the recommended fail-closed assertion is exactly what landed.

**QV-005 — STANDS.** Legacy per-quarry `QuarryPermission` precedence unchanged: `auth.ts:661-687` still reads `QuarryPermissionModel` and still prioritizes the legacy row over membership flags ("If legacy per-quarry permission exists, prioritize it for backwards compatibility", `:684-687`). Dual authority + legacy precedence intact; consolidation remains open.

**QV-008 — STANDS.** `backend/src/modules/documents/service.ts` untouched today (mtime 08:33) — the non-atomic upload chain (`quota reserve → storage put → mark available → idempotency complete → sync append → audit`, best-effort `.catch(() => {})` storage cleanup) is unchanged. New artifacts (`backup:dr` script, `disaster_recovery_drill.test.ts`, `backup/service.ts`) address backup/restore, not upload reconciliation; the reconciliation job recommendation remains open.

## R2.4 What else is new (Android feature work reviewed)

- **In-app updates**: `updates/router.ts` (`GET /app/updates/latest`, `GET /app/updates/download/:versionCode`, withdrawn-release guard, explicit mandatory policy) + Top-level mount without `authenticate` (`app.ts:62`) — a defensible choice for update distribution, provided the client-side integrity chain is real. It is: `UpdateManager.kt` verifies APK **SHA-256** against the manifest, verifies the package **signing certificate matches the installed app** (`verifyPackage/verifySigningCertificate`, `:59-190`, with P+ `hasSigningCertificate`), gates install behind `REQUEST_INSTALL_PACKAGES`, and cleans stale updates. Manifest adds `REQUEST_INSTALL_PACKAGES` (`AndroidManifest.xml:7`). Recommendation: rate-limit the download route and ensure `AppRelease` records include the sha256 field.
- **Platform 3-endpoint network posture** (cleartext): base config denies cleartext (`network_security_config.xml:3`), debug-only variant overlay opens cleartext strictly for `10.0.2.2 / localhost / 127.0.0.1 / 192.168.1.8`; release pins `https://api.quarryvault.com` with minify on (`build.gradle.kts:135-148`). Clean.
- **Profile/Employee management screens**, company trash, folders, role-gated surfaces consistent with the current endpoint set; new unit tests cover profile roles/permissions, update workflow, updates screen, document navigation flow, content-disposition parsing, APK download regression.

## R2.5 Test execution record (first executions of this investigation)

| Run | Scope | Result |
| --- | --- | --- |
| 19:16:48 | `backend` `vitest run tests/security_authorization.test.ts` (isolated MongoMemoryServer; isolated per new setup) | **12/12 passed** (7.6 s) |
| 19:17:06–19:19 | `backend` full `vitest run` (27 files) | **217 passed / 5 failed (222)** — all 5 failures are the stale cross-office-policy tests in §R2.3. Stale fodder, no DB touched (`TEST_MONGODB_URI` unset + throw-on-set enforced by setup) |
| 19:2x | `android :app:testDebugUnitTest` / `:app:compileDebugKotlin` | **BUILD FAILED — `SessionStorage.kt:7/71` unresolved `KeyGenerator` (see §R2.1). Not executed.** |

## R2.6 Updated final status (supersedes the verdict block before §R2)

| ID | Status after re-review #2 |
| --- | --- |
| Issue 1 | **PARTIALLY ADDRESSED in tree** (busy spinner + gating added; no try/catch, no reset-on-open; symptom still needs device repro) |
| Issue 2 | **STILL LIVE** — cause unchanged (BOM material3 1.3.0 + suspension-free true→false); one-frame-delay fallback or BOM/library bump still required |
| Issue 3 | **FIX INTACT in tree** (unverified on device; dead `downloadDocumentToUri` still to remove) |
| Issue 4 | **FIX INTACT in tree** (print path now format-honest; unverified on device) |
| Issue 5 | **STILL LIVE** (three direction authorities unchanged) |
| QV-001 | **FIXED in backend code + tests green** (employee `can_upload` gate; audit; product-policy ratified as "employees with can_upload may create") |
| QV-002 | **WIP fix in tree — compile-blocked by a one-line wrong import; no shipped APK contains it; not verified at runtime** |
| QV-003 | **FIXED in backend code + tests green** (grants, four-eyes, ≤1 h expiry, scoped, audited); **5 stale tests** must be updated |
| QV-004 | **FIXED (dangerous path removed) + verified by execution** (full suite ran under forced in-memory isolation) |
| QV-005 | **STANDS** (legacy permission precedence retained) |
| QV-008 | **STANDS** (upload pipeline untouched; DR/backup work is adjacent, not the reconciliation fix) |

**Immediate action list (in order):** fix `SessionStorage.kt` import (`javax.crypto.KeyGenerator`) → build/`testDebugUnitTest` → update the 5 stale backend tests → remove `onDownloadDocumentToUri`/`downloadDocumentToUri` dead code → implement the Issue-2 minimum-frame-delay (or Bump BOM to a revision carrying material3 ≥ 1.4.0-alpha01) → unify Issue-5 direction authority (single per-app-locale + dialog-window fix) → `createQuarry()` try/catch + reset in `openCreateQuarryDialog()` → then re-verify the two waiting details (Issue 1 symptom, Issue 5 flash frame) on a device.

---

# Re-review #3 — evening 2026-10-30 (~20:45), follow-up after another edit wave

Executed after the developer applied the R2 action list (edits 20:15–20:30 in both Android and backend). Both suites were **executed**.

## R3.1 Verification outcome at a glance

| Item (R2 action) | Status now | Evidence |
| --- | --- | --- |
| `SessionStorage.kt` import fix | **DONE by developer** — line 7 is now `import javax.crypto.KeyGenerator`; full Android compile succeeds | `:app:compileDebugKotlin` green; 203 unit tests executed |
| Android unit suite | **194 / 203 passed**; the 9 failures are a test-harness design issue inside the *new* `pullToRefresh_*` block (§R3.2), not a product defect | `TEST-com.quarryvault.employee.ui.EmployeeAppViewModelTest.xml` |
| Dead `downloadDocumentToUri` / `onDownloadDocumentToUri` | **REMOVED** (zero occurrences; `QuarryDetailScreen.kt` LayeredEffects start at `:130-156`) | grep |
| Issue-2 minimum frame gap | **IMPLEMENTED** — `REFRESH_INDICATOR_MIN_VISIBLE_MILLIS = 17L` (`EmployeeAppViewModel.kt:50`) inside `try` of all three funnels (`:667/:720/:806`) with explanatory comment; sub-frame coalescing now impossible at ≥ 60 fps (17 ms > 16.67 ms) | source + code path |
| Issue-1 exception safety | **IMPLEMENTED** — `createQuarry()` now retries with a `createQuarryJob` guard, wraps the repository call in try/catch (CancellationException rethrown), and `finally { isCreatingQuarry = false; createQuarryJob = null }` (`:1304-1386`); `openCreateQuarryDialog()` seeds the flag from the live job (`:1255`) and `dismissCreateQuarryDialog()` refuses to close while busy (`:1262`); `refreshTrash` also gained its missing catch blocks (`:840-842`) | source |
| Issue-5 direction unification | **IMPLEMENTED as single per-app-locale authority** — `MainActivity` reads a persisted `quarryvault_app_settings/app_language` and sets the window direction once (`:23-35`), then hands `initialIsArabic` + `persistLanguagePreference` into the ViewModel (`:48-56`); `HomeScreen` now derives direction solely from `uiState.isArabic` (`:51`) — configuration-derived conflict eliminated. Residual polish: a *live* toggle updates Compose but not the activity window (`toggleLanguage`, `:1224-1241`, no `recreate()`); on Android 13+ `LocaleManager.setApplicationLocales` remains the clean upgrade | source |
| Backend QV-004 / stale-test purge | **NOT done for the 5 stale cross-office cases** — full suite (28 files, 225 tests) now: **220 passed / 5 failed**, the failures being exactly R2's table (e2e 6.2, stabilization 2.2/2.3, user_management 6, preproduction 5) with identical expected/received pairs. New suites all pass: `server_hosted_releases` 20/20 (incl. the storage-compensation test that is order-sensitive — it also passes standalone), `employee_creation` 7/7, `document_rename`, new `helpers.ts` | run @20:36 |
| `tests/setup.ts` (reliable, throw-on-ext-URI) | still enforced; full suite ran with `TEST_MONGODB_URI` unset and never touched any external DB (memory only) | run + source |

## R3.2 Android — the 9 remaining failures are virtual-time races in the tests themselves

`showNotification()` schedules an auto-dismiss at **+3000 ms** on the ViewModel's scope (`EmployeeAppViewModel.kt:296-315`). Every pullToRefresh test calls `advanceUntilIdle()`, which advances the virtual scheduler **past that timer**, so `activeNotification` is `null` by the time it is asserted (`expected:<ERROR> but was:<null>`). The implementation is correct — the same file's dedicated notification tests already demonstrate the right pattern with `advanceTimeBy(...)` (e.g. `notification_autoDismissesAfterDuration`, `:1250-1267`).

Fix pattern per failing test (replace the `advanceUntilIdle()` idiom):

```kotlin
viewModel.refreshQuarries()
advanceTimeBy(18)   // 17 ms indicator minimum + 1 ms buffer — consumes the refresh, NOT the 3 s timer
runCurrent()

// ... state and notification asserts now observe a live notification ...
assertNotNull(viewModel.uiState.value.activeNotification)

advanceTimeBy(3_000)          // optional: prove the auto-dismiss afterwards
assertNull(viewModel.uiState.value.activeNotification)
```

Apply to: `pullToRefresh_quarriesSuccess_updatesStateAndShowsNotification`, `..._quarriesFailure_preservesExistingDataAndShowsError`, `..._quarriesUnexpectedException_showsErrorAndClearsIndicator`, `..._networkErrors_clearBothIndicatorsAndShowErrors`, `..._contentSuccess_updatesFoldersAndDocuments`, `..._contentUnexpectedException_showsErrorAndClearsIndicator`, `..._authError_mapsToCleanArabicMessageWithoutRawCredentialsError`, `..._trashSuccess_updatesTrashDocuments`, `..._trashUnexpectedExceptionShowsErrorAndClearsIndicator`. The two `assertNull`-heavy cancellation tests already pass and may stay as-is.

## R3.3 Backend — the 5 stale cases and their concrete remediation

They all still encode pre-grant platform-admin behavior. Update each by seeding an active grant the same way `security_authorization.test.ts` does (four-eyes: approver ≠ requester, ≤ 1 h expiry, matching scope):

```ts
await SupportGrantModel.create({
  company_id: otherCompany._id,
  requested_by_platform_admin_id: admin._id,
  approved_by_platform_admin_id: secondAdmin._id,
  scopes: ['document_download'],        // or 'document_metadata_read' to match the request
  status: 'active',
  approved_at: new Date(),
  expires_at: new Date(Date.now() + 30 * 60 * 1000),
});
```

Two cases need a *decision*, not just a seed: `stabilization 2.3` (matching-header download should be 200 only **with a grant** — the new expectation) and `preproduction 5` (platform-admin standard-folder deletion is deliberately outside `document_metadata_read`/`document_download`; either add a `folder_moderation` scope or assert 403 and retire capability).

## R3.4 Updated final status (supersedes §R2.6)

| ID | Status after re-review #3 |
| --- | --- |
| Issue 1 | **FIXED in tree** (busy indicator + full exception safety + job-aware dialog state); pending device symptom re-verification |
| Issue 2 | **FIXED in tree** (17 ms guaranteed indicator frame across all three funnels; per-surface flags). Library defect itself remains pinned (composeBom 2024.10.01 → material3 1.3.0) — opportunistically bump material3 ≥ 1.4.0-alpha01 when convenient; pending device verification |
| Issue 3 | **FIXED in tree** + dead code removed; filename takeover verified by tests; pending device verification |
| Issue 4 | **FIXED in tree** (format-honest PrintManager path); pending device verification |
| Issue 5 | **FIXED structurally in tree** (single persisted per-app language authority; window ↔ composition consistent at startup/resume); minor live-toggle window refresh polish (recreate()/`LocaleManager` on API 33+) |
| QV-002 | **FIXED in tree and unit-tested** — Keystore key provider, `QV2:` versioned AES/GCM with legacy migration, fail-closed reads that clear the session on any crypto failure; `SessionStorageTest` 5/5 within the 194-passing set |
| QV-001 | FIXED + tests green (unchanged from R2) |
| QV-003 | FIXED + tests green; **5 stale suites still to be updated** (§R3.3) |
| QV-004 | FIXED + verified by two more full executions |
| QV-005 | STANDS (unchanged) |
| QV-008 | STANDS (unchanged) |

**Next steps (ordered):** (1) apply §R3.2 pattern to the 9 Android tests → suite expected 203/203; (2) update the 5 stale backend tests with grant seeds/decisions (§R3.3) → suite expected 225/225; (3) commit the working tree (it is now a coherent verified state, one commit or a small series); (4) device verification pass for Issues 1–5 symptoms + a *live* toggleLanguage check (window direction polish).
