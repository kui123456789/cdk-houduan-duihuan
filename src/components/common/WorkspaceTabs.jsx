export function WorkspaceTabs({ tabs, activeTab, onChange }) {
  function moveFocus(nextIndex) {
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    onChange(nextTab.id);
    window.setTimeout(() => {
      document.getElementById(`workspace-tab-${nextTab.id}`)?.focus();
    }, 0);
  }

  function handleKeyDown(event, index) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus((index + 1) % tabs.length);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocus((index - 1 + tabs.length) % tabs.length);
    }
  }

  return (
    <nav className="workspace-tabs" role="tablist" aria-label="工作区切换">
      {tabs.map((tab, index) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            id={`workspace-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`workspace-panel-${tab.id}`}
            className={active ? "workspace-tab active" : "workspace-tab"}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span className="workspace-tab-icon">{tab.icon}</span>
            <span className="workspace-tab-copy">
              <strong>{tab.title}</strong>
              <small>{tab.subtitle}</small>
            </span>
            <span className="workspace-tab-meta">{tab.meta}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function WorkspacePanel({ id, activeTab, children }) {
  if (id !== activeTab) return null;
  return (
    <section
      id={`workspace-panel-${id}`}
      className="workspace-panel"
      role="tabpanel"
      aria-labelledby={`workspace-tab-${id}`}
    >
      {children}
    </section>
  );
}
