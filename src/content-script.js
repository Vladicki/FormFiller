/**
 * fill_proc.js - Core Auto-Fill Logic
 * Extracted and Cleaned for CV Data filling.
 * This file is self-contained and functionally identical to the core of content-script.js.
 */

// --- UTILITIES ---

/**
 * CSS escaping utility.
 * Renamed variables for better readability.
 */
const cssesc = (function () {
  const NON_ASCII_WHITESPACE_REGEX = /[ -,\.\/:-@\[-\^`\{-~]/;
  const IDENTIFIER_SPECIAL_CHAR_REGEX = /[ -,\.\/:-@\[\]\^`\{-~]/;
  const HEX_ESCAPE_REPLACEMENT_REGEX =
    /(^|\\+)?(\\[A-F0-9]{1,6})\x20(?![a-fA-F0-9\x20])/g;

  return function (inputString, options = {}) {
    const preferredQuote = options.quotes == "double" ? '"' : "'";
    const isForIdentifier = options.isIdentifier;
    const firstCharacter = inputString.charAt(0);
    let processedOutput = "";
    let charIndex = 0;
    const inputLength = inputString.length;

    for (; charIndex < inputLength; ) {
      let character = inputString.charAt(charIndex++);
      let codePoint = character.charCodeAt();
      let escapedFragment;

      if (codePoint < 32 || codePoint > 126) {
        if (
          codePoint >= 55296 &&
          codePoint <= 56319 &&
          charIndex < inputLength
        ) {
          let extraCharCode = inputString.charCodeAt(charIndex++);
          (extraCharCode & 64512) == 56320
            ? (codePoint =
                ((codePoint & 1023) << 10) + (extraCharCode & 1023) + 65536)
            : charIndex--;
        }
        escapedFragment = "\\" + codePoint.toString(16).toUpperCase() + " ";
      } else
        options.escapeEverything
          ? NON_ASCII_WHITESPACE_REGEX.test(character)
            ? (escapedFragment = "\\" + character)
            : (escapedFragment =
                "\\" + codePoint.toString(16).toUpperCase() + " ")
          : /[\t\n\f\r\x0B]/.test(character)
            ? (escapedFragment =
                "\\" + codePoint.toString(16).toUpperCase() + " ")
            : character == "\\" ||
                (!isForIdentifier &&
                  ((character == '"' && preferredQuote == character) ||
                    (character == "'" && preferredQuote == character))) ||
                (isForIdentifier &&
                  IDENTIFIER_SPECIAL_CHAR_REGEX.test(character))
              ? (escapedFragment = "\\" + character)
              : (escapedFragment = character);
      processedOutput += escapedFragment;
    }

    if (isForIdentifier) {
      if (/^-[-\d]/.test(processedOutput)) {
        processedOutput = "\\-" + processedOutput.slice(1);
      } else if (/\d/.test(firstCharacter)) {
        processedOutput =
          "\\3" + firstCharacter + " " + processedOutput.slice(1);
      }
    }

    return processedOutput.replace(
      HEX_ESCAPE_REPLACEMENT_REGEX,
      (fullMatch, leadingBackslashes, hexEscape) =>
        leadingBackslashes && leadingBackslashes.length % 2
          ? fullMatch
          : (leadingBackslashes || "") + hexEscape,
    );
  };
})();

/**
 * Normalizes text by removing non-alphanumeric characters and converting to lowercase.
 */
const normalizeText = (text) =>
  (text || "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();

const DEFAULT_EMAIL_SETTINGS = {
  id: "default-email",
  type: "email",
  name: "Email Address",
  match: ["email"],
};

// --- CORE LOGIC (FieldFiller) ---

class FieldFiller {
  constructor(options = {}, profileIndex = -1) {
    this.options = Object.assign(
      {
        fieldMatchSettings: {
          matchName: true,
          matchId: true,
          matchClass: true,
          matchPlaceholder: true,
          matchLabel: true,
          matchAriaLabel: true,
          matchAriaLabelledBy: true,
        },
        triggerClickEvents: true,
        ignoreHiddenFields: true,
        ignoredFields: [],
        confirmFields: ["confirm", "verification", "repeat"],
        defaultMaxLength: 524288,
      },
      options,
    );

    this.profileIndex = profileIndex;
    this.previousValue = "";
    this.previousPassword = "";
  }

  /**
   * Triggers necessary events to let the page know an input has changed.
   */
  fireEvents(targetElement) {
    ["input", "click", "change", "blur"].forEach((eventName) => {
      const event = new Event(eventName, { bubbles: true, cancelable: true });
      targetElement.dispatchEvent(event);
    });
  }

  /**
   * Checks if any pattern matches the given text.
   */
  isAnyMatch(textToMatch, patternsList) {
    if (!textToMatch || !patternsList) return false;
    for (
      let patternsIndex = 0;
      patternsIndex < patternsList.length;
      patternsIndex += 1
    ) {
      if (new RegExp(patternsList[patternsIndex], "i").test(textToMatch))
        return true;
    }
    return false;
  }

  /**
   * Checks if an element is visible on the page.
   */
  isElementVisible(elementToCheck) {
    return !(
      (!elementToCheck.offsetHeight && !elementToCheck.offsetWidth) ||
      window.getComputedStyle(elementToCheck).visibility === "hidden"
    );
  }

  /**
   * Determines if a field should be skipped.
   */
  shouldIgnoreElement(elementToCheck) {
    const inputType = (elementToCheck.type || "").toLowerCase();
    if (
      ["button", "submit", "reset", "hidden", "image"].indexOf(inputType) >
        -1 ||
      (this.options.ignoreHiddenFields &&
        !this.isElementVisible(elementToCheck))
    )
      return true;

    const elementIdentifier = this.getElementName(elementToCheck);
    if (this.isAnyMatch(elementIdentifier, this.options.ignoredFields))
      return true;
    return false;
  }

  /**
   * Gathers all identifying text for an element (id, name, labels, etc.).
   */
  getElementName(elementToIdentify) {
    let combinedIdentifier = "";
    const settings = this.options.fieldMatchSettings;

    if (settings.matchName)
      combinedIdentifier += ` ${normalizeText(elementToIdentify.name)}`;
    if (settings.matchId)
      combinedIdentifier += ` ${normalizeText(elementToIdentify.id)}`;
    if (settings.matchClass)
      combinedIdentifier += ` ${normalizeText(elementToIdentify.className)}`;
    if (settings.matchPlaceholder)
      combinedIdentifier += ` ${normalizeText(elementToIdentify.getAttribute("placeholder") || "")}`;

    if (settings.matchLabel && elementToIdentify.id) {
      try {
        const escapedId = cssesc(elementToIdentify.id, { isIdentifier: true });
        const associatedLabels = document.querySelectorAll(
          `label[for='${escapedId}']`,
        );
        for (
          let labelIndex = 0;
          labelIndex < associatedLabels.length;
          labelIndex += 1
        ) {
          combinedIdentifier += ` ${normalizeText(associatedLabels[labelIndex].innerHTML)}`;
        }
      } catch (error) {}
    }

    if (settings.matchAriaLabel)
      combinedIdentifier += ` ${normalizeText(elementToIdentify.getAttribute("aria-label") || "")}`;

    if (settings.matchAriaLabelledBy) {
      const ariaLabelIds = (
        elementToIdentify.getAttribute("aria-labelledby") || ""
      ).split(" ");
      for (
        let ariaIdIndex = 0;
        ariaIdIndex < ariaLabelIds.length;
        ariaIdIndex += 1
      ) {
        if (ariaLabelIds[ariaIdIndex]) {
          const labelledByElement = document.getElementById(
            ariaLabelIds[ariaIdIndex],
          );
          if (labelledByElement) {
            combinedIdentifier += ` ${normalizeText(labelledByElement.innerHTML || "")}`;
          }
        }
      }
    }
    return combinedIdentifier.trim();
  }

  /**
   * Matches element identity against CV_DATA to find the correct value.
   */
  generateCV_Data(targetElement) {
    if (typeof CV_DATA === "undefined" || !CV_DATA.FOR_FILLER) return "";

    const fillerDataSource = CV_DATA.FOR_FILLER;
    const elementIdentity = this.getElementName(targetElement);
    const lowercaseIdentity = elementIdentity.toLowerCase();
    let matchedValue = "";

    // Direct match check in keys
    for (const dataKey in fillerDataSource) {
      if (
        elementIdentity.startsWith(dataKey) ||
        lowercaseIdentity.startsWith(dataKey.toLowerCase())
      ) {
        matchedValue = fillerDataSource[dataKey];
        break;
      }
    }

    if (!matchedValue) {
      // Heuristic extraction logic
      if (lowercaseIdentity.includes("firstname"))
        matchedValue = fillerDataSource["first-name"] || "";
      else if (lowercaseIdentity.includes("lastname"))
        matchedValue = fillerDataSource["last-name"] || "";
      else if (
        lowercaseIdentity.includes("fullname") ||
        lowercaseIdentity.includes("name")
      ) {
        if (lowercaseIdentity.includes("first"))
          matchedValue = fillerDataSource["first-name"] || "";
        else if (lowercaseIdentity.includes("last"))
          matchedValue = fillerDataSource["last-name"] || "";
        else if (lowercaseIdentity.includes("prefer"))
          matchedValue = fillerDataSource["first-name"] || "";
        else matchedValue = fillerDataSource["full-name"] || "";
      } else if (lowercaseIdentity.includes("email"))
        matchedValue = fillerDataSource["email"] || "";
      else if (lowercaseIdentity.includes("city"))
        matchedValue = fillerDataSource["city"] || "";
      else if (
        lowercaseIdentity.includes("phone") ||
        lowercaseIdentity.includes("tel") ||
        lowercaseIdentity.includes("mobile")
      )
        matchedValue = fillerDataSource["telephone"] || "";
      else if (
        lowercaseIdentity.includes("zip") ||
        lowercaseIdentity.includes("postal")
      )
        matchedValue = fillerDataSource["zip"] || "";
      else if (lowercaseIdentity.includes("country"))
        matchedValue = fillerDataSource["country"] || "";
      else if (lowercaseIdentity.includes("address"))
        matchedValue = fillerDataSource["address"] || "";
      else if (lowercaseIdentity.includes("github"))
        matchedValue = fillerDataSource["github"] || "";
      else if (lowercaseIdentity.includes("linkedin"))
        matchedValue = fillerDataSource["linkedin"] || "";
      else if (
        lowercaseIdentity.includes("website") ||
        lowercaseIdentity.includes("url")
      )
        matchedValue = fillerDataSource["url"] || "";
      else if (
        lowercaseIdentity.includes("org") ||
        lowercaseIdentity.includes("company") ||
        lowercaseIdentity.includes("employer")
      )
        matchedValue = fillerDataSource["organization"] || "";
      else if (
        lowercaseIdentity.includes("user") &&
        lowercaseIdentity.includes("name")
      )
        matchedValue = fillerDataSource["username"] || "";
      else if (
        lowercaseIdentity.includes("uni") ||
        lowercaseIdentity.includes("college") ||
        lowercaseIdentity.includes("school")
      )
        matchedValue = fillerDataSource["university"] || "";
      else if (lowercaseIdentity.includes("degree"))
        matchedValue = fillerDataSource["degree"] || "";
      else if (
        lowercaseIdentity.includes("grad") &&
        lowercaseIdentity.includes("year")
      )
        matchedValue = fillerDataSource["graduation-year"] || "";
      else if (
        lowercaseIdentity.includes("position") ||
        lowercaseIdentity.includes("role")
      )
        matchedValue =
          fillerDataSource["position"] || fillerDataSource["job-title"] || "";
      else if (
        lowercaseIdentity.includes("start") &&
        (lowercaseIdentity.includes("year") ||
          lowercaseIdentity.includes("date"))
      )
        matchedValue = fillerDataSource["start-year"] || "";
      else if (
        lowercaseIdentity.includes("end") &&
        (lowercaseIdentity.includes("year") ||
          lowercaseIdentity.includes("date"))
      )
        matchedValue = fillerDataSource["end-year"] || "";
      else if (
        lowercaseIdentity.includes("desc") ||
        lowercaseIdentity.includes("detail") ||
        lowercaseIdentity.includes("responsib")
      )
        matchedValue =
          fillerDataSource["job-description"] ||
          fillerDataSource["summary"] ||
          "";
      else if (lowercaseIdentity.includes("skill"))
        matchedValue = fillerDataSource["skills"] || "";
      else if (
        lowercaseIdentity.includes("summary") ||
        lowercaseIdentity.includes("bio") ||
        lowercaseIdentity.includes("about")
      )
        matchedValue = fillerDataSource["summary"] || "";
      else if (lowercaseIdentity.includes("nation"))
        matchedValue = fillerDataSource["nationality"] || "";
      else if (
        lowercaseIdentity.includes("job") ||
        (lowercaseIdentity.includes("title") &&
          (lowercaseIdentity.includes("work") ||
            lowercaseIdentity.includes("past") ||
            lowercaseIdentity.includes("current")))
      ) {
        matchedValue =
          fillerDataSource["What is your current or previous job title?"] ||
          fillerDataSource["job-title"] ||
          fillerDataSource["position"] ||
          "";
      } else if (lowercaseIdentity.includes("title"))
        matchedValue = fillerDataSource["title"] || "";
      else if (
        lowercaseIdentity.includes("province") ||
        lowercaseIdentity.includes("state")
      )
        matchedValue = fillerDataSource["province"] || "";
      else if (
        lowercaseIdentity.includes("pay") ||
        lowercaseIdentity.includes("salary")
      )
        matchedValue = fillerDataSource["desiredPay"] || "";
      else if (lowercaseIdentity.includes("sponsor"))
        matchedValue = fillerDataSource["Sponsorship"] || "";
      else if (lowercaseIdentity.includes("expertise"))
        matchedValue = fillerDataSource["expertise"] || "";
      else if (lowercaseIdentity.includes("location"))
        matchedValue =
          fillerDataSource["current-location"] ||
          fillerDataSource["location"] ||
          "";
      else if (lowercaseIdentity.includes("employed"))
        matchedValue = fillerDataSource["Have you ever been employed by"] || "";
      else if (
        lowercaseIdentity.includes("opt-in") ||
        lowercaseIdentity.includes("receive") ||
        lowercaseIdentity.includes("marketing")
      )
        matchedValue = fillerDataSource["Do you opt-in to receive"] || "";
      else if (
        lowercaseIdentity.includes("cv") ||
        lowercaseIdentity.includes("resume")
      )
        matchedValue = fillerDataSource["cv_link"] || "";
    }

    if (Array.isArray(matchedValue)) return matchedValue[0] || "";
    return matchedValue;
  }

  /**
   * Sets the value of a specific element based on matched data.
   */
  fillElement(targetElement) {
    if (this.shouldIgnoreElement(targetElement)) return;

    const inputType = (targetElement.type || "").toLowerCase();
    const tagName = targetElement.tagName.toLowerCase();
    const inputName = (targetElement.name || "").toLowerCase();

    if (tagName === "input") {
      if (inputType === "radio") {
        const generatedValue = this.generateCV_Data(targetElement);
        if (generatedValue) {
          const normalizedGenerated = normalizeText(generatedValue);
          const elementValue = targetElement.value;
          const elementIdentity = this.getElementName(targetElement);

          if (
            elementValue === generatedValue ||
            normalizeText(elementValue) === normalizedGenerated ||
            normalizeText(elementIdentity).includes(normalizedGenerated)
          ) {
            targetElement.checked = true;
          }
        }
      } else if (inputType === "checkbox") {
        const generatedValue = this.generateCV_Data(targetElement);
        if (generatedValue) {
          const lowVal = generatedValue.toString().toLowerCase();
          if (
            lowVal === "yes" ||
            lowVal === "true" ||
            lowVal === "1" ||
            lowVal === "checked"
          ) {
            targetElement.checked = true;
          } else if (
            lowVal === "no" ||
            lowVal === "false" ||
            lowVal === "0" ||
            lowVal === "unchecked"
          ) {
            targetElement.checked = false;
          }
        }
      } else if (inputType === "file") {
        const normalizedName = this.getElementName(targetElement).toLowerCase();
        if (
          normalizedName.includes("cv") ||
          normalizedName.includes("resume") ||
          normalizedName.includes("attach")
        ) {
          const cvPath = CV_DATA.FOR_FILLER.cv_path;
          if (cvPath)
            console.log(
              "%c CV_FILLER: Detected upload field. Path: " + cvPath,
              "color: #0ea5e9; font-weight: bold;",
            );
        }
      } else if (inputType === "password") {
        if (this.isAnyMatch(inputName, this.options.confirmFields)) {
          targetElement.value = this.previousPassword;
        } else {
          this.previousPassword = CV_DATA.FOR_FILLER.password || "";
          targetElement.value = this.previousPassword;
        }
      } else if (
        inputType === "email" &&
        this.isAnyMatch(inputName, this.options.confirmFields)
      ) {
        targetElement.value = this.previousValue;
      } else {
        const generatedValue = this.generateCV_Data(targetElement);
        if (generatedValue) {
          this.previousValue = generatedValue;
          targetElement.value = generatedValue;
        }
      }
    } else if (tagName === "textarea") {
      const generatedValue = this.generateCV_Data(targetElement);
      if (generatedValue) targetElement.value = generatedValue;
    } else if (tagName === "select") {
      const generatedValue = this.generateCV_Data(targetElement);
      if (generatedValue) {
        const normalizedGenerated = normalizeText(generatedValue);
        let bestMatchIndex = -1;
        let bestMatchScore = 0; // 3: Exact, 2: Normalized Exact, 1: Partial

        for (
          let optionIndex = 0;
          optionIndex < targetElement.options.length;
          optionIndex++
        ) {
          const option = targetElement.options[optionIndex];
          const optionValue = option.value;
          const optionText = option.text;
          const normalizedVal = normalizeText(optionValue);
          const normalizedText = normalizeText(optionText);

          // Priority 1: Exact match
          if (optionValue === generatedValue || optionText === generatedValue) {
            bestMatchIndex = optionIndex;
            bestMatchScore = 3;
            break;
          }

          // Priority 2: Normalized exact match
          if (
            bestMatchScore < 2 &&
            (normalizedVal === normalizedGenerated ||
              normalizedText === normalizedGenerated)
          ) {
            bestMatchIndex = optionIndex;
            bestMatchScore = 2;
          }

          // Priority 3: Partial match (contains)
          if (
            bestMatchScore < 1 &&
            normalizedGenerated.length > 0 &&
            (normalizedVal.includes(normalizedGenerated) ||
              normalizedText.includes(normalizedGenerated) ||
              normalizedGenerated.includes(normalizedVal) ||
              normalizedGenerated.includes(normalizedText))
          ) {
            bestMatchIndex = optionIndex;
            bestMatchScore = 1;
          }
        }

        if (bestMatchIndex !== -1) {
          targetElement.selectedIndex = bestMatchIndex;
        }
      }
    }

    if (this.options.triggerClickEvents) this.fireEvents(targetElement);
  }
}

// --- ORCHESTRATOR (FillerManager) ---

class FillerManager {
  constructor(options = {}, profileIndex = -1, isEnabled = true) {
    this.elementFiller = new FieldFiller(options, profileIndex);
    this.clickedElement = null;
    this.isEnabled = isEnabled;
  }

  setClickedElement(element) {
    if (this.isEnabled) this.clickedElement = element;
  }

  /**
   * Scans a container and fills all supported inputs.
   */
  fillAllElements(container = document) {
    if (!this.isEnabled) return;
    const inputElements = container.querySelectorAll(
      "input:not(:disabled):not([readonly])",
    );
    const textareaElements = container.querySelectorAll(
      "textarea:not(:disabled):not([readonly])",
    );
    const selectElements = container.querySelectorAll(
      "select:not(:disabled):not([readonly])",
    );
    const contentEditableElements = container.querySelectorAll(
      "[contenteditable='true']",
    );

    inputElements.forEach((input) => this.elementFiller.fillElement(input));
    textareaElements.forEach((textarea) =>
      this.elementFiller.fillElement(textarea),
    );
    selectElements.forEach((select) => this.elementFiller.fillElement(select));
    contentEditableElements.forEach((editable) => {
      editable.textContent = this.elementFiller.generateCV_Data(editable);
      this.elementFiller.fireEvents(editable);
    });
  }

  fillAllInputs() {
    this.fillAllElements(document);
  }

  /**
   * Fills only the currently active or clicked input.
   */
  fillThisInput() {
    if (!this.isEnabled) return;
    const targetElement = this.clickedElement || document.activeElement;
    if (targetElement) {
      const tagName = targetElement.tagName.toLowerCase();
      if (
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        targetElement.isContentEditable
      ) {
        this.elementFiller.fillElement(targetElement);
      }
    }
    this.clickedElement = null;
  }

  /**
   * Fills all inputs in the form containing the active element.
   */
  fillThisForm() {
    if (!this.isEnabled) return;
    const targetElement = this.clickedElement || document.activeElement;
    if (targetElement && targetElement.tagName.toLowerCase() !== "body") {
      const parentForm = targetElement.closest("form");
      if (parentForm) this.fillAllElements(parentForm);
      else this.fillAllElements(document); // Fallback to whole page
    }
    this.clickedElement = null;
  }
}

// --- INITIALIZATION ---

/**
 * Connects the manager to extension options and handles URL matching.
 */
function setupExtension(extensionOptions, isProVersion = false) {
  let matchedProfileIndex = -1;
  let isExtensionEnabled = true;
  const currentUrl = window.location.href;

  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.sendMessage
  ) {
    chrome.runtime.sendMessage(
      { type: "clearProfileBadge" },
      () => chrome.runtime.lastError,
    );
    chrome.runtime.sendMessage(
      { type: "clearIgnoreDomainBadge" },
      () => chrome.runtime.lastError,
    );

    if (isProVersion && currentUrl && extensionOptions.profiles) {
      for (
        let profileIndex = 0;
        profileIndex < extensionOptions.profiles.length;
        profileIndex += 1
      ) {
        const profile = extensionOptions.profiles[profileIndex];
        if (currentUrl.match(new RegExp(profile.urlMatch))) {
          matchedProfileIndex = profileIndex;
          chrome.runtime.sendMessage(
            { type: "setProfileBadge", data: profile },
            () => chrome.runtime.lastError,
          );
          break;
        }
      }
    }

    if (extensionOptions.ignoreDomains) {
      for (
        let domainIndex = 0;
        domainIndex < extensionOptions.ignoreDomains.length;
        domainIndex += 1
      ) {
        if (
          currentUrl.match(
            new RegExp(extensionOptions.ignoreDomains[domainIndex]),
          )
        ) {
          isExtensionEnabled = false;
          chrome.runtime.sendMessage(
            { type: "setIgnoreDomainBadge" },
            () => chrome.runtime.lastError,
          );
          break;
        }
      }
    }
  }

  window.filler = new FillerManager(
    extensionOptions,
    matchedProfileIndex,
    isExtensionEnabled,
  );
}

/**
 * Handles messages received from the popup or background script.
 */
function handleMessage(message) {
  if (message.type === "receiveNewOptions") {
    setupExtension(message.data.options, message.data.isProEdition);
    return true;
  }
  return null;
}

// Environment Detection and Startup
if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  chrome.runtime.onMessage
) {
  document.addEventListener("mousedown", (mouseEvent) => {
    if (mouseEvent.button === 2 && window.filler) {
      window.filler.setClickedElement(mouseEvent.target);
    }
  });

  chrome.runtime.sendMessage({ type: "getOptions" }, (optionsResponse) => {
    if (optionsResponse && optionsResponse.options)
      setupExtension(optionsResponse.options, optionsResponse.isProEdition);
  });

  chrome.runtime.onMessage.addListener(handleMessage);
} else {
  // Standalone mode (browser console or direct script injection)
  window.filler = new FillerManager();
  console.log(
    "CV_FILLER: Standalone mode active. Run window.filler.fillAllInputs() to fill page.",
  );
}
