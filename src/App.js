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
import Tablebox from "./components/Tablebox";

const defaultLanguage = "sql";
const defaultTheme = Object.keys(themes).sort()[0];

function getColumnNames(input) {
  return (/\bselect\b\s+([\S\s]+?)from/i.exec(input) || [, ""])[1].split(
    /\s*,\s*/g
  );
}

function getTableNames(input) {
  // function takes a sql query and returns an array of table names
  // var aliases = sql.match(/(?<=\b(?:from|join) )\w+(?: (?!\bjoin\b)\w+)?/g);
  var aliases = input.match(/(?<=\b(?:from|join) )\w+(?: (?!\bjoin\b)\w+)?/g);
  if (aliases === null) {
    return [];
  }
  var TableMap = {};
  aliases.forEach((alias) => {
    var splited = alias.trim().split(" ");
    if (splited.length === 1) {
      TableMap[alias.toLowerCase()] = alias.toLowerCase();
    } else {
      TableMap[splited[0].toLowerCase()] = splited[1].toLowerCase();
    }
  });
  return TableMap;
}

function random(number) {
  return Math.floor(Math.random() * number);
}
function randomColor() {
  return "rgb(" + random(255) + "," + random(255) + "," + random(255) + ")";
}

// sql query parser
function Sql(key, text,colors,handlesetColors) {
  var columns = getColumnNames(text);
  var tables = getTableNames(text);
  var alias = {};
  for (var table in tables) {
    alias[tables[table]] = table;
  }
  // make a random color for each table as a dictionary
  Object.keys(tables).forEach((table) => {
    if(!colors[table]){
    handlesetColors(table,randomColor());
    }
   }
  );
  var total_tables = Object.keys(tables).length;
  var first_table = Object.keys(tables)[0];
  return (
    <div
      style={{ display: "flex", marginBottom: "4px" }}
      className="arrow-steps clearfix"
    >
      {columns.map((text, index) => {
        if (
          text.trim().toLowerCase() !== "select" &&
          text.toLowerCase() !== ""
        ) {
          return (
            <Box backgroundColor={colors[total_tables===1?first_table: alias[text.split(".")[0].toLowerCase()]]} key={index} color="#fff" className="step">
              {text}
            </Box>
          );
        } else return <></>;
      })}
    </div>
  );
}

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
