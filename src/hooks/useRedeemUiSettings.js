import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_UI_SETTINGS,
  DEFAULT_WORKSPACE_TAB,
  WORKSPACE_TABS
} from "../config/redeemConstants.js";

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeWorkspaceTab(value) {
  const id = String(value || "").trim();
  return WORKSPACE_TABS.some((tab) => tab.id === id) ? id : DEFAULT_WORKSPACE_TAB;
}

export function normalizeUiSettings(settings) {
  const source = normalizeObject(settings);
  return {
    ...DEFAULT_UI_SETTINGS,
    activeDetailRowId: String(source.activeDetailRowId || ""),
    activeWorkspaceTab: normalizeWorkspaceTab(source.activeWorkspaceTab),
    pollingEnabled: source.pollingEnabled === true,
    showApiKey: source.showApiKey === true
  };
}

export function useRedeemUiSettings(initialUiSettings, { saveUiSettings } = {}) {
  const normalizedInitialSettings = normalizeUiSettings(initialUiSettings);
  const saveUiSettingsRef = useRef(saveUiSettings);
  const [activeWorkspaceTab, setActiveWorkspaceTabState] = useState(
    () => normalizedInitialSettings.activeWorkspaceTab
  );
  const [activeDetailRowId, setActiveDetailRowIdState] = useState(
    () => normalizedInitialSettings.activeDetailRowId
  );
  const [showApiKey, setShowApiKeyState] = useState(() => normalizedInitialSettings.showApiKey);

  useEffect(() => {
    saveUiSettingsRef.current = saveUiSettings;
  }, [saveUiSettings]);

  useEffect(() => {
    saveUiSettingsRef.current?.({ activeWorkspaceTab });
  }, [activeWorkspaceTab]);

  useEffect(() => {
    saveUiSettingsRef.current?.({ activeDetailRowId });
  }, [activeDetailRowId]);

  useEffect(() => {
    saveUiSettingsRef.current?.({ showApiKey });
  }, [showApiKey]);

  const setActiveWorkspaceTab = useCallback((valueOrUpdater) => {
    setActiveWorkspaceTabState((current) => {
      const nextValue =
        typeof valueOrUpdater === "function" ? valueOrUpdater(current) : valueOrUpdater;
      return normalizeWorkspaceTab(nextValue);
    });
  }, []);

  const selectWorkspaceTab = useCallback(
    (tabId) => {
      setActiveWorkspaceTab(tabId);
    },
    [setActiveWorkspaceTab]
  );

  const setActiveDetailRowId = useCallback((valueOrUpdater) => {
    setActiveDetailRowIdState((current) => {
      const nextValue =
        typeof valueOrUpdater === "function" ? valueOrUpdater(current) : valueOrUpdater;
      return String(nextValue || "");
    });
  }, []);

  const setShowApiKey = useCallback((valueOrUpdater) => {
    setShowApiKeyState((current) =>
      typeof valueOrUpdater === "function" ? valueOrUpdater(current) === true : valueOrUpdater === true
    );
  }, []);

  const toggleApiKeyVisible = useCallback(() => {
    setShowApiKey((value) => !value);
  }, [setShowApiKey]);

  return {
    activeWorkspaceTab,
    setActiveWorkspaceTab,
    selectWorkspaceTab,
    activeDetailRowId,
    setActiveDetailRowId,
    showApiKey,
    setShowApiKey,
    toggleApiKeyVisible
  };
}
