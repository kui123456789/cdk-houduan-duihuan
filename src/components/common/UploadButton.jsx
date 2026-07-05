import { Upload } from "lucide-react";

export function UploadButton({ label, onChange }) {
  return (
    <label className="upload-button">
      <Upload size={15} />
      {label}
      <input type="file" accept=".txt,text/plain" onChange={onChange} />
    </label>
  );
}
