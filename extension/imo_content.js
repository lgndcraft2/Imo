const HIDDEN_SELECTOR = "script, style, noscript, template, svg, canvas, iframe";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isVisibleElement(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (current.matches(HIDDEN_SELECTOR) || current.hidden || current.getAttribute("aria-hidden") === "true") {
      return false;
    }

    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") {
      return false;
    }

    current = current.parentElement;
  }

  return element.getClientRects().length > 0 || element === document.body;
}

function extractVisibleText() {
  if (!document.body) {
    return "";
  }

  const chunks = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = normalizeText(node.nodeValue);
      if (!text) {
        return NodeFilter.FILTER_REJECT;
      }

      const parent = node.parentElement;
      if (!parent || parent.closest(HIDDEN_SELECTOR) || !isVisibleElement(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    chunks.push(normalizeText(walker.currentNode.nodeValue));
  }

  return normalizeText(chunks.join(" "));
}

function getAssociatedLabelText(field) {
  const labels = new Set();

  if (field.labels) {
    Array.from(field.labels).forEach((label) => labels.add(normalizeText(label.textContent)));
  }

  if (field.id) {
    document.querySelectorAll(`label[for="${CSS.escape(field.id)}"]`).forEach((label) => {
      labels.add(normalizeText(label.textContent));
    });
  }

  const wrappingLabel = field.closest("label");
  if (wrappingLabel) {
    labels.add(normalizeText(wrappingLabel.textContent));
  }

  return Array.from(labels).filter(Boolean);
}

function matchesKey(candidate, key) {
  const candidateKey = normalizeKey(candidate);
  const searchKey = normalizeKey(key);
  if (!candidateKey || !searchKey) {
    return false;
  }

  return candidateKey === searchKey || candidateKey.includes(searchKey) || searchKey.includes(candidateKey);
}

function getFormFields() {
  return Array.from(document.querySelectorAll("input, textarea, select")).filter((field) => isVisibleElement(field));
}

function findFieldForKey(key) {
  const fields = getFormFields();

  const labelMatch = fields.find((field) => getAssociatedLabelText(field).some((label) => matchesKey(label, key)));
  if (labelMatch) {
    return labelMatch;
  }

  const nameMatch = fields.find((field) => matchesKey(field.getAttribute("name"), key));
  if (nameMatch) {
    return nameMatch;
  }

  const placeholderMatch = fields.find((field) => matchesKey(field.getAttribute("placeholder"), key));
  if (placeholderMatch) {
    return placeholderMatch;
  }

  return null;
}

function dispatchValueEvents(field) {
  field.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  field.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

function setSelectValue(field, value) {
  const target = normalizeText(value);
  const options = Array.from(field.options || []);
  const matchedOption = options.find((option) => matchesKey(option.textContent, target) || matchesKey(option.value, target));

  if (matchedOption) {
    field.value = matchedOption.value;
  } else {
    field.value = String(value);
  }

  dispatchValueEvents(field);
}

function setBooleanFieldValue(field, value) {
  const normalized = normalizeKey(value);
  const truthy = ["true", "yes", "1", "on", "checked", "y"];
  const shouldCheck = truthy.includes(normalized) || normalized === normalizeKey(field.value);

  if (field.type === "radio") {
    if (shouldCheck) {
      field.checked = true;
      dispatchValueEvents(field);
    }
    return;
  }

  field.checked = shouldCheck;
  dispatchValueEvents(field);
}

function setFieldValue(field, value) {
  if (!field) {
    return false;
  }

  if (field.tagName === "SELECT") {
    setSelectValue(field, value);
    return true;
  }

  if (field.type === "checkbox" || field.type === "radio") {
    setBooleanFieldValue(field, value);
    return true;
  }

  field.value = String(value);
  dispatchValueEvents(field);
  return true;
}

function fillFormFields(fields) {
  if (!fields || typeof fields !== "object") {
    return 0;
  }

  let filled = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      continue;
    }

    const field = findFieldForKey(key);
    if (field && setFieldValue(field, value)) {
      filled += 1;
    }
  }

  return filled;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getText") {
    sendResponse({ text: extractVisibleText() });
    return true;
  }

  if (message?.type === "fillForms") {
    const payload = message.fields || message.data || message.payload || {};
    const filled = fillFormFields(payload);
    sendResponse({ ok: true, filled });
    return true;
  }

  return undefined;
});
