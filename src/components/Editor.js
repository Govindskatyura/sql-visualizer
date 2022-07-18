import "./Editor.css";

export const Editor = ({ placeHolder, onChange, onKeyDown ,value}) => {
  return (
    <textarea
      className="editor"
      placeholder={placeHolder}
      onChange={onChange}
      value={value}
    ></textarea>
  );
};