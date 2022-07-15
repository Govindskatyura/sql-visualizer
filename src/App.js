import React, { useState } from "react";
import { Dropdown } from "./components/Dropdown";
import { Editor } from "./components/Editor";
import { Highlighter } from "./components/Highlighter";
import * as themes from "react-syntax-highlighter/dist/esm/styles/hljs";
import * as languages from "react-syntax-highlighter/dist/esm/languages/hljs";
import "./App.css";
import FileUpload from "./components/FileUpload";
import { useForm } from "react-hook-form";

const defaultLanguage = (
  <code>{"javascript" || Object.keys(languages).sort()[10]}</code>
);
const defaultTheme = (
  <code>{"atomOneDark" || Object.keys(themes).sort()[5]}</code>
);

export default function App() {
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState(defaultLanguage);
  const [theme, setTheme] = useState(defaultTheme);
  const {
    handleSubmit,
    register,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm();
  return (
    <div className="App">
      <div className="ControlsBox">
        <Dropdown
          defaultTheme={defaultLanguage}
          onChange={(e) => setLanguage(e.target.value)}
          data={languages}
        />
        <Dropdown
          defaultTheme={defaultTheme}
          onChange={(e) => setTheme(e.target.value)}
          data={themes}
        />
      </div>
      <div className="PanelsBox">
        <Editor
          placeHolder="Type your code here..."
          onChange={(e) => setInput(e.target.value)}
        />
        <Highlighter language={language} theme={themes[theme]}>
          {input}
        </Highlighter>
      </div>
      <FileUpload
        name="avatar"
        acceptedFileTypes="image/*"
        isRequired={false}
        placeholder="Your avatar"
        control={control}
      >
        New avatar
      </FileUpload>
    </div>
  );
}
