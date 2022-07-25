import React, { useState } from "react";
import { Dropdown } from "./components/Dropdown";
import { Editor } from "./components/Editor";
import { Highlighter } from "./components/Highlighter";
import * as themes from "react-syntax-highlighter/dist/esm/styles/hljs";
import * as languages from "react-syntax-highlighter/dist/esm/languages/hljs";
import "./App.css";
import FileUpload from "./components/FileUpload";
import { useForm } from "react-hook-form";
import { Box, Grid } from "@chakra-ui/react";

const defaultLanguage = "sql";
const defaultTheme = Object.keys(themes).sort()[0];

function Sql(key, text) {
  return (
    <Grid display={"flex"} overflow={"scroll"} mt={2}>
      {text.split(" ").map((text, index) => (
        <Box bg="green.100" key={index} p={4} ml={1} color="black">
          {text}
        </Box>
      ))}
    </Grid>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState(defaultLanguage);
  const [theme, setTheme] = useState(defaultTheme);
  const {
    // handleSubmit,
    // register,
    // setError,
    control,
    // formState: { errors, isSubmitting },
  } = useForm();

  const showfile = async (e) => {
    e.preventDefault();
    console.log("sadasd");
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      setInput(text);
    };
    reader.readAsText(e.target.files[0]);
  };

  return (
    <div className="App">
      <div className="Visualizer">
        <Box bg="red.500" w="100%" p={4} color="#f0f0f0" pb={2}>
          {input
            .split(";")
            .map((query, index) => Sql(index,query))
            }
        </Box>
      </div>
      <div className="ControlsBox">
        <Dropdown
          defaultTheme={defaultLanguage}
          value={defaultLanguage}
          onChange={(e) => setLanguage(e.target.value)}
          data={{ sql: languages.sql }}
        />
        <Dropdown
          defaultTheme={defaultTheme}
          onChange={(e) => setTheme(e.target.value)}
          data={themes}
        />
      </div>
      <div
        className="PanelsBox"
        style={{ maxHeight: "80vh", overflowY: "scroll" }}
      >
        <Editor
          placeHolder="Type your code here..."
          onChange={(e) => setInput(e.target.value)}
          value={input}
        />
        <Highlighter language={language} theme={themes[theme]}>
          {input}
        </Highlighter>
      </div>
      <div className="container">
        <FileUpload
          name="avatar"
          acceptedFileTypes=".sql"
          isRequired={false}
          placeholder="Your avatar"
          control={control}
          showfile={showfile}
        >
          New avatar
        </FileUpload>
      </div>
    </div>
  );
}
