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
    this.resetGroupTracking();
  }

  /**
   * Resets tracking for grouped fields (Jobs, Education).
   */
  resetGroupTracking() {
    this.groupIndices = {
      job: 0,
      education: 0,
    };
    this.filledInGroup = {
      job: new Set(),
      education: new Set(),
    };
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
    if (typeof CV_DATA === "undefined") {
      console.error("CV_FILLER: CV_DATA is undefined in the current context.");
      return "";
    }

    const profile = CV_DATA.CANDIDATE_PROFILE || {};
    const contact = profile.Contact || {};
    const educationData = profile.EDUCATION || {};
    const experienceData = profile.Professional_experience || {};
    const skills = CV_DATA.TECHNICAL_AND_SOFT_SKILLS || {};

    const fillerDataSource = CV_DATA.FOR_FILLER || {};
    const elementIdentity = this.getElementName(targetElement);
    const lowercaseIdentity = elementIdentity.toLowerCase();
    let matchedValue = "";

    console.log(
      `%c CV_FILLER: Processing field: "${elementIdentity}"`,
      "color: #3b82f6",
    );

    // Helper to join array or return string
    const formatValue = (val) => (Array.isArray(val) ? val[0] : val);

    // Direct match check in FOR_FILLER
    for (const dataKey in fillerDataSource) {
      if (
        elementIdentity.startsWith(dataKey) ||
        lowercaseIdentity.startsWith(dataKey.toLowerCase())
      ) {
        matchedValue = fillerDataSource[dataKey];
        console.log(
          `   -> Direct match found in FOR_FILLER["${dataKey}"]:`,
          matchedValue,
        );
        return formatValue(matchedValue);
      }
    }

    // --- GROUP TRACKING LOGIC ---
    let category = null; // 'job', 'education', 'personal'
    let fieldType = null; // 'title', 'company', 'start', etc.

    // Identify Field Category and Type
    if (
      lowercaseIdentity.includes("uni") ||
      lowercaseIdentity.includes("college") ||
      lowercaseIdentity.includes("school") ||
      lowercaseIdentity.includes("degree") ||
      (lowercaseIdentity.includes("grad") &&
        (lowercaseIdentity.includes("year") ||
          lowercaseIdentity.includes("date")))
    ) {
      category = "education";
      if (
        lowercaseIdentity.includes("uni") ||
        lowercaseIdentity.includes("college") ||
        lowercaseIdentity.includes("school")
      )
        fieldType = "name";
      else if (lowercaseIdentity.includes("degree")) fieldType = "degree";
      else if (
        lowercaseIdentity.includes("grad") ||
        lowercaseIdentity.includes("end")
      )
        fieldType = "end";
      else if (lowercaseIdentity.includes("start")) fieldType = "start";
    } else if (
      lowercaseIdentity.includes("job") ||
      lowercaseIdentity.includes("company") ||
      lowercaseIdentity.includes("org") ||
      lowercaseIdentity.includes("employer") ||
      lowercaseIdentity.includes("position") ||
      lowercaseIdentity.includes("role") ||
      lowercaseIdentity.includes("responsib") ||
      lowercaseIdentity.includes("desc")
    ) {
      category = "job";
      if (
        lowercaseIdentity.includes("title") ||
        lowercaseIdentity.includes("position") ||
        lowercaseIdentity.includes("role")
      )
        fieldType = "title";
      else if (
        lowercaseIdentity.includes("company") ||
        lowercaseIdentity.includes("org") ||
        lowercaseIdentity.includes("employer")
      )
        fieldType = "company";
      else if (
        lowercaseIdentity.includes("desc") ||
        lowercaseIdentity.includes("responsib") ||
        lowercaseIdentity.includes("detail")
      )
        fieldType = "desc";
      else if (lowercaseIdentity.includes("start")) fieldType = "start";
      else if (lowercaseIdentity.includes("end")) fieldType = "end";
    }

    // Update indices if we hit a field type we've already filled in this group
    if (category && fieldType) {
      if (this.filledInGroup[category].has(fieldType)) {
        this.groupIndices[category]++;
        this.filledInGroup[category].clear();
        console.log(
          `CV_FILLER: Detected new ${category} group. Index now ${this.groupIndices[category]}`,
        );
      }
      this.filledInGroup[category].add(fieldType);
    }

    // Retrieve Data based on category and index
    if (category === "job") {
      const jobKeys = Object.keys(experienceData).sort();
      const jobKey = jobKeys[this.groupIndices.job] || jobKeys[0];
      const job = experienceData[jobKey] || {};

      if (fieldType === "title") matchedValue = job.Job_title;
      else if (fieldType === "company")
        matchedValue = job.Organization || job.Company;
      else if (fieldType === "desc")
        matchedValue = Array.isArray(job.job_description)
          ? job.job_description.join("\n")
          : job.job_description;
      else if (fieldType === "start")
        matchedValue = job.Start_date || fillerDataSource["start-year"];
      else if (fieldType === "end")
        matchedValue = job.End_date || fillerDataSource["end-year"];
    } else if (category === "education") {
      const eduKeys = Object.keys(educationData).sort();
      const eduKey = eduKeys[this.groupIndices.education] || eduKeys[0];
      const eduEntry = educationData[eduKey] || {};
      const uni = eduEntry.University || eduEntry; // Handle nested or flat

      if (fieldType === "name") matchedValue = uni.University_name || uni.Name;
      else if (fieldType === "degree")
        matchedValue = formatValue(uni.TypeOfDegree);
      else if (fieldType === "end")
        matchedValue = uni.GraduationYear || formatValue(uni.End_date);
      else if (fieldType === "start")
        matchedValue = formatValue(uni.Start_date);
    }

    // --- FALLBACK TO HEURISTICS (Personal info, etc.) ---
    if (!matchedValue) {
      if (lowercaseIdentity.includes("firstname"))
        matchedValue = profile.FirstName || fillerDataSource["first-name"];
      else if (lowercaseIdentity.includes("lastname"))
        matchedValue = profile.LastName || fillerDataSource["last-name"];
      else if (
        lowercaseIdentity.includes("fullname") ||
        lowercaseIdentity.includes("name")
      ) {
        if (lowercaseIdentity.includes("first"))
          matchedValue = profile.FirstName || fillerDataSource["first-name"];
        else if (lowercaseIdentity.includes("last"))
          matchedValue = profile.LastName || fillerDataSource["last-name"];
        else matchedValue = profile.Name || fillerDataSource["full-name"];
      } else if (lowercaseIdentity.includes("email"))
        matchedValue = contact.Email || fillerDataSource["email"];
      else if (lowercaseIdentity.includes("city"))
        matchedValue = profile.City || fillerDataSource["city"];
      else if (
        lowercaseIdentity.includes("phone") ||
        lowercaseIdentity.includes("tel") ||
        lowercaseIdentity.includes("mobile")
      ) {
        if (
          lowercaseIdentity.includes("code") ||
          lowercaseIdentity.includes("country") ||
          lowercaseIdentity.includes("dial")
        ) {
          matchedValue = contact.Country_Code || contact.PhoneNoCountryCode;
        } else if (
          lowercaseIdentity.includes("type") ||
          lowercaseIdentity.includes("device")
        ) {
          matchedValue = contact.Phone_Device_Type;
        } else {
          // Heuristic: If there is a separate Country_Code field or the label suggests it's just the number
          const hasCountryCodeInProfile =
            contact.Country_Code || contact.Phone.startsWith("+");
          matchedValue =
            hasCountryCodeInProfile && contact.PhoneNoCountryCode
              ? contact.PhoneNoCountryCode
              : contact.Phone || fillerDataSource["telephone"];
        }
      } else if (
        lowercaseIdentity.includes("zip") ||
        lowercaseIdentity.includes("postal")
      )
        matchedValue =
          profile.PostalCode_Eircode_Address || fillerDataSource["zip"];
      else if (lowercaseIdentity.includes("country"))
        matchedValue = profile.Location || fillerDataSource["country"];
      else if (lowercaseIdentity.includes("address"))
        matchedValue =
          profile.PostalCode_Eircode_Address && profile.City
            ? `${profile.PostalCode_Eircode_Address}, ${profile.City}, ${profile.Location}`
            : fillerDataSource["address"];
      else if (lowercaseIdentity.includes("github"))
        matchedValue = contact.GitHub || fillerDataSource["github"];
      else if (lowercaseIdentity.includes("linkedin"))
        matchedValue = contact.LinkedIn || fillerDataSource["linkedin"];
      else if (
        lowercaseIdentity.includes("website") ||
        lowercaseIdentity.includes("url")
      )
        matchedValue = contact.Web_CV || profile.url || fillerDataSource["url"];
      else if (lowercaseIdentity.includes("skill"))
        matchedValue =
          (skills.Technical_Skills_Comprehensive
            ? skills.Technical_Skills_Comprehensive.join(", ")
            : "") || fillerDataSource["skills"];
      else if (
        lowercaseIdentity.includes("summary") ||
        lowercaseIdentity.includes("bio") ||
        lowercaseIdentity.includes("about")
      )
        matchedValue = profile.Primary_Expertise || fillerDataSource["summary"];
      else if (lowercaseIdentity.includes("nation"))
        matchedValue = profile.Nationality || fillerDataSource["nationality"];
      else if (
        lowercaseIdentity.includes("province") ||
        lowercaseIdentity.includes("state")
      )
        matchedValue = profile.County || fillerDataSource["province"];
      else if (
        lowercaseIdentity.includes("pay") ||
        lowercaseIdentity.includes("salary")
      )
        matchedValue = profile.desiredPay || fillerDataSource["desiredPay"];
      else if (lowercaseIdentity.includes("sponsor"))
        matchedValue = profile.Sponsorship || fillerDataSource["Sponsorship"];
      else if (
        lowercaseIdentity.includes("pronoun") ||
        lowercaseIdentity.includes("pronounce")
      )
        matchedValue = profile.Pronouns;
      else if (
        lowercaseIdentity.includes("gender") ||
        lowercaseIdentity.includes("sex")
      )
        matchedValue = profile.Gender;
      else if (
        lowercaseIdentity.includes("us") &&
        (lowercaseIdentity.includes("hear") ||
          lowercaseIdentity.includes("source") ||
          lowercaseIdentity.includes("referral"))
      )
        matchedValue = profile.Hear_about_us;
      else if (
        lowercaseIdentity.includes("currently") &&
        (lowercaseIdentity.includes("employee") ||
          lowercaseIdentity.includes("employed"))
      )
        matchedValue =
          profile.currently_employee_of ||
          profile["Have you ever been employed by"];
      else if (
        lowercaseIdentity.includes("disability") ||
        lowercaseIdentity.includes("disabled")
      )
        matchedValue = profile.Disability;
      else if (lowercaseIdentity.includes("location"))
        matchedValue = profile.Location || fillerDataSource["current-location"];

      if (matchedValue) {
        console.log(`   -> Heuristic match found:`, matchedValue);
      } else {
        console.log(`   -> No match found for "${elementIdentity}"`);
      }
    }

    return formatValue(matchedValue) || "";
  }

  /**
   * Sets the value of a specific element based on matched data.
   */
  fillElement(targetElement) {
    if (this.shouldIgnoreElement(targetElement)) {
      console.log(`CV_FILLER: Skipping ignored/hidden element:`, targetElement);
      return;
    }

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
            console.log(`CV_FILLER: Checking radio button: ${elementIdentity}`);
            targetElement.checked = true;
          }
        }
      } else if (inputType === "checkbox") {
        const generatedValue = this.generateCV_Data(targetElement);
        if (generatedValue) {
          const lowVal = generatedValue.toString().toLowerCase();
          console.log(
            `CV_FILLER: Setting checkbox "${this.getElementName(targetElement)}" to ${lowVal}`,
          );
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
          const profile =
            (typeof CV_DATA !== "undefined" && CV_DATA.CANDIDATE_PROFILE) || {};
          const contact = profile.Contact || {};
          const cvPath =
            (Array.isArray(contact.cv_link) ? contact.cv_link[1] : "") ||
            (typeof CV_DATA !== "undefined" && CV_DATA.FOR_FILLER
              ? CV_DATA.FOR_FILLER.cv_path
              : "");
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
          const profile =
            (typeof CV_DATA !== "undefined" && CV_DATA.CANDIDATE_PROFILE) || {};
          const contact = profile.Contact || {};
          this.previousPassword =
            contact.pwd ||
            contact.default_password ||
            (typeof CV_DATA !== "undefined" && CV_DATA.FOR_FILLER
              ? CV_DATA.FOR_FILLER.password
              : "") ||
            "";
          targetElement.value = this.previousPassword;
        }
        console.log(`CV_FILLER: Filled password field.`);
      } else if (
        inputType === "email" &&
        this.isAnyMatch(inputName, this.options.confirmFields)
      ) {
        targetElement.value = this.previousValue;
        console.log(`CV_FILLER: Filled email confirmation field.`);
      } else {
        const generatedValue = this.generateCV_Data(targetElement);
        if (generatedValue) {
          console.log(
            `CV_FILLER: Filling input "${this.getElementName(targetElement)}" with:`,
            generatedValue,
          );
          this.previousValue = generatedValue;
          targetElement.value = generatedValue;
        }
      }
    } else if (tagName === "textarea") {
      const generatedValue = this.generateCV_Data(targetElement);
      if (generatedValue) {
        console.log(`CV_FILLER: Filling textarea with:`, generatedValue);
        targetElement.value = generatedValue;
      }
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
          console.log(
            `CV_FILLER: Selecting option index ${bestMatchIndex} for "${this.getElementName(targetElement)}"`,
          );
          targetElement.selectedIndex = bestMatchIndex;
        } else {
          console.warn(
            `CV_FILLER: No matching option found for select "${this.getElementName(targetElement)}" with value "${generatedValue}"`,
          );
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
    if (!this.isEnabled) {
      console.warn("CV_FILLER: Filler is disabled for this domain/profile.");
      return;
    }
    this.elementFiller.resetGroupTracking();
    console.log("CV_FILLER: Starting to fill all elements in:", container);
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

    console.log(
      `CV_FILLER: Found ${inputElements.length} inputs, ${textareaElements.length} textareas, ${selectElements.length} selects, ${contentEditableElements.length} editables.`,
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

console.log("CV_FILLER: Content script loaded and initializing...");

/**
 * Connects the manager to extension options and handles URL matching.
 */
function setupExtension(extensionOptions, isProVersion = false) {
  let matchedProfileIndex = -1;
  let isExtensionEnabled = true;
  const currentUrl = window.location.href;

  console.log(
    "CV_FILLER: Setting up extension with options:",
    extensionOptions,
  );

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
  console.log("CV_FILLER: window.filler initialized and ready.");
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
    else {
      // Fallback if no options returned
      window.filler = new FillerManager();
      console.log(
        "CV_FILLER: Initialized with default options (no response from background).",
      );
    }
  });

  chrome.runtime.onMessage.addListener(handleMessage);
} else {
  // Standalone mode (browser console or direct script injection)
  window.filler = new FillerManager();
  console.log(
    "CV_FILLER: Standalone mode active. Run window.filler.fillAllInputs() to fill page.",
  );
}
