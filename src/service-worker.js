(function () {
  "use strict";

  const getUUID = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0,
        v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  const getEmailSettings = () => ({
    id: getUUID(),
    type: "email",
    name: "Email Address",
    match: ["email"],
    emailPrefix: "",
    emailUsername: "random",
    emailUsernameList: ["jack", "jill"],
    emailUsernameRegEx: "",
    emailHostname: "list",
    emailHostnameList: ["mailinator.com"],
  });

  const getDefaultOptions = () => {
    const options = {
      version: 1,
      agreeTermsFields: ["agree", "terms", "conditions"],
      confirmFields: ["confirm", "reenter", "retype", "repeat", "secondary"],
      defaultMaxLength: 20,
      enableContextMenu: true,
      fieldMatchSettings: {
        matchLabel: true,
        matchAriaLabel: true,
        matchAriaLabelledBy: true,
        matchId: true,
        matchName: true,
        matchClass: false,
        matchPlaceholder: false,
      },
      fields: [],
      ignoredFields: ["captcha", "hipinputtext"],
      ignoreFieldsWithContent: false,
      ignoreHiddenFields: true,
      passwordSettings: { mode: "defined", password: "Pa$$w0rd!" },
      ignoreDomains: [],
      profiles: [],
      triggerClickEvents: true,
    };

    options.fields.push({ id: getUUID(), type: "username", name: "Username", match: ["userid", "username"] });
    options.fields.push({ id: getUUID(), type: "first-name", name: "First Name", match: ["firstname"] });
    options.fields.push({ id: getUUID(), type: "last-name", name: "Last Name", match: ["lastname", "surname", "secondname"] });
    options.fields.push(getEmailSettings());
    options.fields.push({ id: getUUID(), type: "organization", name: "Organization or Company Name", match: ["organization", "organisation", "company"] });
    options.fields.push({ id: getUUID(), type: "full-name", name: "Full Name", match: ["fullname", "name"] });
    options.fields.push({ id: getUUID(), type: "telephone", name: "Telephone Number", match: ["phone", "fax"], template: "+1 (XxX) XxX-XxxX" });
    options.fields.push({ id: getUUID(), type: "number", name: "A Random Number between 1 and 1000", match: ["integer", "number", "numeric", "income", "price", "qty", "quantity"], min: 1, max: 1000, decimalPlaces: 0 });
    options.fields.push({ id: getUUID(), type: "number", name: "Zip Code", match: ["zip"], min: 10000, max: 99999, decimalPlaces: 0 });
    options.fields.push({ id: getUUID(), type: "number", name: "Day", match: ["day"], min: 1, max: 28, decimalPlaces: 0 });
    options.fields.push({ id: getUUID(), type: "number", name: "Month", match: ["month"], min: 1, max: 12, decimalPlaces: 0 });
    options.fields.push({ id: getUUID(), type: "number", name: "Year", match: ["year"], min: 1970, max: 2019, decimalPlaces: 0 });
    options.fields.push({ id: getUUID(), type: "date", name: "Date", match: ["date"], minDate: "1970-01-01", max: 0, template: "DD-MMM-YYYY" });
    options.fields.push({ id: getUUID(), type: "url", name: "Website Address", match: ["website"] });
    options.fields.push({ id: getUUID(), type: "regex", name: "Address Line 1", match: ["address1", "addressline1"], template: "([1-9][0-9][0-9]?) (North |East |West |South |||||)(Green |White |Rocky ||||||||)(Nobel|Fabien|Hague|Oak|Second|First|Cowley|Clarendon|New|Old|Milton) (Avenue|Boulevard|Court|Drive|Extension|Freeway|Lane|Parkway|Road|Street)" });
    options.fields.push({ id: getUUID(), type: "regex", name: "P.O. Box", match: ["pobox", "postbox"], template: "((P\\.O\\.)|(PO)) Box [1-9][0-9]{0,4}" });

    return options;
  };

  const getOptions = () =>
    new Promise((resolve) => {
      chrome.storage.local.get("options", (data) => {
        resolve(data && data.options ? data.options : getDefaultOptions());
      });
    });

  const setupContextMenus = (enabled) => {
    chrome.contextMenus.removeAll();
    if (enabled) {
      chrome.contextMenus.create({ id: "filler-all", title: "Fill all inputs", contexts: ["page", "editable"] });
      chrome.contextMenus.create({ id: "filler-form", title: "Fill this form", contexts: ["editable"] });
      chrome.contextMenus.create({ id: "filler-input", title: "Fill this input", contexts: ["editable"] });
    }
  };

  const isProEdition = true;

  async function getActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? -1;
  }

  function broadcastNewOptions(options) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab?.id && tab.id !== chrome.tabs.TAB_ID_NONE) {
          chrome.tabs.sendMessage(tab.id, { type: "receiveNewOptions", data: { options, isProEdition } }, () => chrome.runtime.lastError);
        }
      });
    });
  }

  function onMessageListener(message, sender, sendResponse) {
    switch (message.type) {
      case "getOptions":
        getOptions().then((options) => {
          sendResponse({ options, isProEdition });
        });
        return true;
      case "setIgnoreDomainBadge":
        chrome.action.setBadgeText({ text: "x", tabId: sender.tab?.id });
        chrome.action.setBadgeBackgroundColor({ color: "#7b2b2b", tabId: sender.tab?.id });
        chrome.action.setTitle({ title: `${chrome.i18n.getMessage("actionTitle")}\n${chrome.i18n.getMessage("domainIsIgnored")}`, tabId: sender.tab?.id });
        return true;
      case "clearIgnoreDomainBadge":
        chrome.action.setBadgeText({ text: "", tabId: sender.tab?.id });
        return true;
      case "setProfileBadge":
        chrome.action.setBadgeText({ text: "★", tabId: sender.tab?.id });
        chrome.action.setBadgeBackgroundColor({ color: "#757575", tabId: sender.tab?.id });
        chrome.action.setTitle({ title: `${chrome.i18n.getMessage("actionTitle")}\n${chrome.i18n.getMessage("matchedProfile")}: ${message.data.name}`, tabId: sender.tab?.id });
        return true;
      case "clearProfileBadge":
        chrome.action.setBadgeText({ text: "", tabId: sender.tab?.id });
        return true;
      case "optionsUpdated":
        getOptions().then((options) => {
          broadcastNewOptions(options);
          setupContextMenus(options.enableContextMenu);
        });
        return true;
      default:
        return null;
    }
  }

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "update" || details.reason === "install") {
      getOptions().then((options) => {
        if (!options.ignoreDomains) options.ignoreDomains = [];
        chrome.storage.local.set({ options });
        setupContextMenus(options.enableContextMenu);
      });
    }
  });

  chrome.runtime.onMessage.addListener(onMessageListener);

  function fillAllInputsAction() {
    window.filler && window.filler.fillAllInputs();
  }
  function fillThisFormAction() {
    window.filler && window.filler.fillThisForm();
  }
  function fillThisInputAction() {
    window.filler && window.filler.fillThisInput();
  }

  getOptions().then((options) => {
    setupContextMenus(options.enableContextMenu);
  });

  chrome.action.onClicked.addListener(async () => {
    chrome.scripting.executeScript({
      func: fillAllInputsAction,
      target: { allFrames: true, tabId: await getActiveTabId() },
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info) => {
    const tabId = await getActiveTabId();
    if (info.menuItemId === "filler-all") {
      chrome.scripting.executeScript({ func: fillAllInputsAction, target: { allFrames: true, tabId } });
    } else if (info.menuItemId === "filler-form") {
      chrome.scripting.executeScript({ func: fillThisFormAction, target: { allFrames: true, tabId } });
    } else if (info.menuItemId === "filler-input") {
      chrome.scripting.executeScript({ func: fillThisInputAction, target: { allFrames: true, tabId } });
    }
  });

  chrome.commands.onCommand.addListener(async (command) => {
    const tabId = await getActiveTabId();
    if (command === "fill_all_inputs") {
      chrome.scripting.executeScript({ func: fillAllInputsAction, target: { allFrames: true, tabId } });
    } else if (command === "fill_this_form") {
      chrome.scripting.executeScript({ func: fillThisFormAction, target: { allFrames: true, tabId } });
    } else if (command === "fill_this_input") {
      chrome.scripting.executeScript({ func: fillThisInputAction, target: { allFrames: true, tabId } });
    }
  });
})();
