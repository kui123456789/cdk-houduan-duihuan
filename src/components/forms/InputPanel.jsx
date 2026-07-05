import { PanelHeader } from "../common/PanelHeader";

export function InputPanel({ title, subtitle, count, icon, actions, upload, children }) {
  return (
    <section className="input-panel">
      <div className="section-heading">
        <PanelHeader icon={icon} title={title} subtitle={subtitle} />
        <div className="panel-actions">
          <span className="count-badge">{count}</span>
          {actions || upload}
        </div>
      </div>
      {children}
    </section>
  );
}
