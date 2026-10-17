(() => {
  "use strict";

  const element = (id) => document.getElementById(id);
  const screens = [element("setup-screen"), element("challenge-screen"), element("results-screen")];
  const form = element("settings-form");
  const secondsInput = element("time-limit");
  const countInput = element("question-count");
  const startButton = element("start-button");
  const formError = element("form-error");
  const progress = element("time-progress");
  const progressFill = element("time-progress-fill");
  const timeRemaining = element("time-remaining");
  const retryButton = element("retry-load");
  const historyScroll = element("history-scroll");
  const soundToggle = element("sound-enabled");
  const switchSound = element("switch-sound");
  const soundNotice = element("sound-notice");
  const categoryError = element("category-error");
  const DATA_TYPES = ["directions", "lines"];
  const CATEGORIES = ["male", "female", "common"];
  const DATA_FILES = DATA_TYPES.flatMap((type) =>
    CATEGORIES.map((category) => ({
      type,
      file: `${type}/${category}.txt`,
      input: element(`${type}-${category}`),
    }))
  );
  const DATA_TIMEOUT_MS = 10000;
  const TIMER_INTERVAL_MS = 50;
  let directions = [];
  let lines = [];
  let loadedData = null;
  let previewPrompt = null;
  let session = null;
  let timerId = null;
  let soundAttempt = 0;

  function stopSound() {
    soundAttempt += 1;
    switchSound.pause();
    switchSound.currentTime = 0;
  }

  function disableSound() {
    soundToggle.checked = false;
    stopSound();
    soundNotice.textContent = "効果音を再生できなかったため、音をOFFにしました。チャレンジはそのまま続けられます。";
    soundNotice.hidden = false;
  }

  function playSwitchSound() {
    if (!soundToggle.checked || document.visibilityState !== "visible") return;
    const attempt = ++soundAttempt;
    try {
      switchSound.pause();
      switchSound.currentTime = 0;
      switchSound.play().catch((error) => {
        // 次のお題や終了操作による中断は、再生エラーとして扱わない。
        if (attempt === soundAttempt && error.name !== "AbortError") disableSound();
      });
    } catch {
      disableSound();
    }
  }

  function showScreen(id, heading) {
    screens.forEach((screen) => { screen.hidden = screen.id !== id; });
    element(heading).focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes ? `${minutes}分` : ""}${seconds ? `${seconds}秒` : ""}`;
  }

  function getSettings() {
    const seconds = readInteger(secondsInput);
    const count = readInteger(countInput);
    return {
      seconds: seconds.value,
      count: count.value,
      validSeconds: seconds.valid,
      validCount: count.valid,
    };
  }

  function readInteger(input) {
    const value = Number(input.value);
    const valid = input.value.trim() !== "" && Number.isInteger(value)
      && value >= Number(input.getAttribute("min")) && value <= Number(input.getAttribute("max"));
    return { value, valid };
  }

  function renderSettingsValidation({ validSeconds, validCount }) {
    const valid = validSeconds && validCount;
    formError.hidden = valid;
    formError.textContent = valid ? "" : "制限時間は1〜120秒、出題回数は1〜100回の整数で入力してください。";
    [[secondsInput, validSeconds], [countInput, validCount]].forEach(([input, inputValid]) => {
      if (inputValid) input.removeAttribute("aria-invalid");
      else input.setAttribute("aria-invalid", "true");
    });
    return valid;
  }

  function updateEstimate() {
    const settings = getSettings();
    const { seconds, count, validSeconds, validCount } = settings;
    element("duration-summary").textContent = validSeconds && validCount ? `約${formatDuration(seconds * count)}` : "—";
    if (!formError.hidden) renderSettingsValidation(settings);
  }

  async function readItems(file, signal) {
    let response;
    let text;
    try {
      response = await fetch(`data/${file}`, { cache: "no-store", signal });
      if (response.ok) text = await response.text();
    } catch {
      throw new Error(`data/${file} を読み込めませんでした。接続を確認し、HTTPサーバーまたは公開URLから開いてください。`);
    }
    if (!response.ok) {
      throw new Error(`data/${file} を読み込めませんでした（HTTP ${response.status}）。ファイルの配置を確認してください。`);
    }
    return [...new Set(text.split(/\r\n|\n|\r/).map((item) => item.trim()).filter(Boolean))];
  }

  function selectedItems(type) {
    return [...new Set(DATA_FILES
      .filter((entry) => entry.type === type && entry.input.checked)
      .flatMap((entry) => loadedData.get(entry.file)))];
  }

  function applyCategories() {
    if (!loadedData) return;
    directions = selectedItems("directions");
    lines = selectedItems("lines");
    const selectedBoth = DATA_TYPES.every((type) =>
      DATA_FILES.some((entry) => entry.type === type && entry.input.checked)
    );
    const ready = directions.length > 0 && lines.length > 0;
    let message = "";
    if (!selectedBoth) message = "演技指示とセリフを、それぞれ1カテゴリ以上ONにしてください。";
    else if (!ready) message = "選んだカテゴリに有効なお題がありません。別のカテゴリをONにするか、データを追加してください。";
    categoryError.textContent = message;
    categoryError.hidden = ready;
    startButton.disabled = !ready;
    const counts = `演技指示 ${directions.length}種類・セリフ ${lines.length}種類`;
    element("data-status").textContent = `${counts}${ready ? "で遊べます" : "を選択中"}`;
    previewPrompt = null;
    renderPreview();
  }

  async function loadData() {
    loadedData = null;
    directions = [];
    lines = [];
    previewPrompt = null;
    renderPreview();
    startButton.disabled = true;
    retryButton.disabled = true;
    element("data-error").hidden = true;
    categoryError.hidden = true;
    categoryError.textContent = "";
    element("data-status").textContent = "お題を読み込んでいます…";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), DATA_TIMEOUT_MS);
    try {
      const items = await Promise.all(DATA_FILES.map((entry) => readItems(entry.file, controller.signal)));
      loadedData = new Map(DATA_FILES.map((entry, index) => [entry.file, items[index]]));
      applyCategories();
    } catch (error) {
      directions = [];
      lines = [];
      element("data-error-message").textContent = error.message;
      element("data-error").hidden = false;
      element("data-status").textContent = "お題を読み込むと、チャレンジを開始できます。";
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
      retryButton.disabled = false;
    }
  }

  function pickPrompt(previous = null) {
    const combinations = directions.length * lines.length;
    let index = Math.floor(Math.random() * (combinations - (previous && combinations > 1 ? 1 : 0)));
    // 直前の組み合わせの位置を飛ばし、再抽選の無限ループを避ける。
    if (previous && combinations > 1 && index >= previous.index) index += 1;
    return {
      index,
      direction: directions[Math.floor(index / lines.length)],
      line: lines[index % lines.length],
    };
  }

  function renderPreview() {
    if (directions.length === 0 || lines.length === 0) {
      element("preview-direction").textContent = "—";
      element("preview-line").textContent = "—";
      return;
    }
    previewPrompt = pickPrompt(previewPrompt);
    element("preview-direction").textContent = previewPrompt.direction;
    element("preview-line").textContent = `「${previewPrompt.line}」`;
  }

  function addPrompt() {
    session.history.push(pickPrompt(session.history.at(-1)));
  }

  function renderPrompt() {
    const current = session.history.at(-1);
    element("question-number").textContent = session.history.length;
    element("current-direction").textContent = current.direction;
    element("current-line").textContent = `「${current.line}」`;
  }

  function stopTimer() {
    window.clearTimeout(timerId);
    timerId = null;
  }

  function renderHistory(history) {
    const fragment = document.createDocumentFragment();
    history.forEach((prompt, index) => {
      const row = document.createElement("tr");
      [index + 1, prompt.direction, prompt.line].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });
      fragment.append(row);
    });
    element("history-body").replaceChildren(fragment);
    element("history-count").textContent = `${history.length}問`;
  }

  function finishChallenge(stopped) {
    stopTimer();
    stopSound();
    const finished = session;
    session = null;
    renderHistory(finished.history);
    element("result-summary").textContent = stopped
      ? `${finished.count}問中${finished.history.length}問で途中終了しました。ここまでのお題を振り返ろう。`
      : `${finished.count}問のチャレンジ完了。あなたのお気に入りの組み合わせは？`;
    element("timing-note").hidden = !finished.caughtUp;
    showScreen("results-screen", "results-title");
    historyScroll.scrollTop = 0;
  }

  function advanceSession(now) {
    const previousLength = session.history.length;
    const elapsed = Math.max(0, now - session.startedAt);
    // コールバック回数ではなく開始時刻からの経過で進め、遅延分もまとめて反映する。
    const scheduledCount = Math.min(session.count, Math.floor(elapsed / session.duration) + 1);
    while (session.history.length < scheduledCount) addPrompt();
    const added = session.history.length - previousLength;
    const complete = elapsed >= session.count * session.duration;
    if (added > 1 || (complete && added > 0)) session.caughtUp = true;
    return { elapsed, added, complete };
  }

  function updateChallenge(now, suppressSound = false) {
    if (!session) return;
    const { elapsed, added, complete } = advanceSession(now);
    if (complete) {
      finishChallenge(false);
      return;
    }
    if (added > 0) {
      renderPrompt();
      if (!suppressSound) playSwitchSound();
    }
    const remaining = Math.max(0, session.history.length * session.duration - elapsed);
    const seconds = String(Math.ceil(remaining / 1000));
    if (timeRemaining.textContent !== seconds) timeRemaining.textContent = seconds;
    if (progress.getAttribute("aria-valuenow") !== seconds) progress.setAttribute("aria-valuenow", seconds);
    progressFill.style.transform = `scaleX(${remaining / session.duration})`;
  }

  function tick(suppressSound = false) {
    updateChallenge(performance.now(), suppressSound);
    if (session) timerId = window.setTimeout(tick, TIMER_INTERVAL_MS);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (session || directions.length === 0 || lines.length === 0) return;
    const settings = getSettings();
    const { seconds, count, validSeconds } = settings;
    if (!renderSettingsValidation(settings)) {
      (validSeconds ? countInput : secondsInput).focus();
      return;
    }
    session = { duration: seconds * 1000, count, startedAt: performance.now(), history: [], caughtUp: false };
    element("total-questions").textContent = count;
    progress.setAttribute("aria-valuemax", seconds);
    addPrompt();
    renderPrompt();
    showScreen("challenge-screen", "challenge-title");
    playSwitchSound();
    tick();
  });

  element("stop-button").addEventListener("click", () => {
    if (!session) return;
    const { added, complete } = advanceSession(performance.now());
    // 終了直前に補完したお題は画面に描画されないため、履歴に注記する。
    if (added > 0) session.caughtUp = true;
    finishChallenge(!complete);
  });
  element("restart-button").addEventListener("click", () => {
    renderPreview();
    showScreen("setup-screen", "setup-title");
  });
  retryButton.addEventListener("click", loadData);
  DATA_FILES.forEach((entry) => entry.input.addEventListener("change", applyCategories));
  secondsInput.addEventListener("input", updateEstimate);
  countInput.addEventListener("input", updateEstimate);
  soundToggle.addEventListener("change", () => {
    soundNotice.hidden = true;
    soundNotice.textContent = "";
    if (!soundToggle.checked) stopSound();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      stopSound();
    } else if (session) {
      stopTimer();
      tick(true);
    }
  });
  updateEstimate();
  loadData();
})();
