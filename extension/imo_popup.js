const voiceSelect = document.getElementById("voice-select");
const detectLanguageBtn = document.getElementById("detect-language-btn");
const readAloudBtn = document.getElementById("read-aloud-btn");
const voiceInputBtn = document.getElementById("voice-input-btn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

let providerConfig = {
  backendBaseUrl: "http://localhost:8000",
  backendAccessToken: "",
};

let currentAudio = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setResult(value) {
  resultEl.textContent = value || "";
}

function setBusy(isBusy) {
  [detectLanguageBtn, readAloudBtn, voiceInputBtn].forEach((button) => {
    button.disabled = isBusy;
  });
}

function detailToString(detail) {
  if (!detail) {
    return "Unknown error.";
  }

  if (typeof detail === "string") {
    return detail;
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function normalizeBaseUrl(rawUrl) {
  return String(rawUrl || "").trim().replace(/\/+$/, "");
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!tabs || !tabs.length) {
        reject(new Error("No active tab found."));
        return;
      }

      resolve(tabs[0]);
    });
  });
}

function sendToContent(message) {
  return getActiveTab().then(
    (tab) =>
      new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          resolve(response);
        });
      }),
  );
}

async function fetchBackend(path, body) {
  const baseUrl = normalizeBaseUrl(providerConfig.backendBaseUrl) || "http://localhost:8000";
  const headers = {};

  if (!(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  if (providerConfig.backendAccessToken) {
    headers.Authorization = `Bearer ${providerConfig.backendAccessToken}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: body instanceof FormData ? body : JSON.stringify(body),
  });

  const data = await response.json().catch(async () => {
    const text = await response.text().catch(() => "");
    return text ? { detail: text } : {};
  });

  if (!response.ok) {
    throw new Error(detailToString(data.detail || data.error || `HTTP ${response.status}`));
  }

  return data;
}

async function getPageText() {
  const response = await sendToContent({ type: "getText" });
  const text = response?.text || "";
  if (!text.trim()) {
    throw new Error("No visible page text was found.");
  }
  return text;
}

async function loadProviderConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_PROVIDER_CONFIG" }, (response) => {
      if (!chrome.runtime.lastError && response?.providerConfig) {
        providerConfig = response.providerConfig;
      }
      resolve();
    });
  });
}

async function detectLanguage() {
  setBusy(true);
  setStatus("Detecting language...");
  setResult("");

  try {
    const text = await getPageText();
    const data = await fetchBackend("/api/imo/detect-language", { text });
    const confidence = typeof data.confidence === "number" ? `${(data.confidence * 100).toFixed(1)}%` : "0%";
    setStatus("Language detected.");
    setResult(`Language: ${data.language || "unknown"}\nConfidence: ${confidence}`);
  } catch (error) {
    setStatus(error.message, true);
    setResult("");
  } finally {
    setBusy(false);
  }
}

async function readAloud() {
  setBusy(true);
  setStatus("Preparing audio...");
  setResult("");

  try {
    const text = await getPageText();
    const voice = voiceSelect.value || "Idera";
    const data = await fetchBackend("/api/imo/read-aloud", { text, voice });
    const audioBase64 = data.audio_base64 || data.audioBase64;

    if (!audioBase64) {
      throw new Error("Backend did not return audio.");
    }

    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }

    currentAudio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
    await currentAudio.play();
    setStatus("Playing read-aloud audio.");
    setResult(`Voice: ${voice}`);
  } catch (error) {
    setStatus(error.message, true);
    setResult("");
  } finally {
    setBusy(false);
  }
}

function recordMicBlob() {
  return new Promise(async (resolve, reject) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      reject(new Error("Microphone access is not supported in this browser."));
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      reject(new Error("Microphone permission was denied."));
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error("MediaRecorder is not supported in this browser."));
      return;
    }

    const options = MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined;
    const recorder = new MediaRecorder(stream, options);
    const chunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error(event.error?.message || "Recording failed."));
    };

    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (!chunks.length) {
        reject(new Error("No audio was captured."));
        return;
      }

      resolve(new Blob(chunks, { type: "audio/webm" }));
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, 5000);
  });
}

async function voiceInput() {
  setBusy(true);
  setStatus("Requesting microphone permission...");
  setResult("");

  try {
    const blob = await recordMicBlob();
    setStatus("Uploading voice note...");

    const formData = new FormData();
    formData.append("audio", blob, "voice-input.webm");

    const data = await fetchBackend("/api/imo/voice-to-form", formData);
    setStatus("Filling form fields...");
    setResult(JSON.stringify(data, null, 2));

    const fillResponse = await sendToContent({ type: "fillForms", fields: data });
    const filledCount = fillResponse?.filled ?? 0;
    setStatus(`Voice input applied to ${filledCount} field${filledCount === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(error.message, true);
    setResult("");
  } finally {
    setBusy(false);
  }
}

voiceSelect.value = "Idera";

detectLanguageBtn.addEventListener("click", detectLanguage);
readAloudBtn.addEventListener("click", readAloud);
voiceInputBtn.addEventListener("click", voiceInput);

loadProviderConfig().then(() => {
  setStatus("Ready.");
});
