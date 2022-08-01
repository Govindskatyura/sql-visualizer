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
import Sql from "./components/Sql";

const defaultLanguage = "sql";
const defaultTheme = Object.keys(themes).sort()[0];


export default function App() {
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState(defaultLanguage);
  const [theme, setTheme] = useState(defaultTheme);
  const [colors , setColors] = useState({});
  const handlesetColors = (table, color) => {
    setColors({...colors, [table]: color});
  }

  const {control} = useForm();
  const last_index = input.lastIndexOf(";");

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
        <Box bg="#f0f0f0" w="100%" maxHeight={'300px'}  overflow={'scroll'} p={4} color="#f0f0f0" pb={2}>
          <Grid mt={2}>
              <Grid item display={'flex'}>
                {Object.keys(colors).map((table,index) => {
                  return (
                    <Box key={table} backgroundColor={colors[table]} color="#fff" p={1} borderRadius={4} m={1} px={4} h={8} textAlign='center' justifyContent={'center'}>
                      {table}
                    </Box>
                  );}
                )}
              </Grid>
              <Grid item>
                {input.slice(0,last_index).split(";").map((query, index) => Sql(index, query,colors,handlesetColors))}
            </Grid>
          </Grid>
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
         SQL FILE
        </FileUpload>
      </div>
    </div>
  );
}
