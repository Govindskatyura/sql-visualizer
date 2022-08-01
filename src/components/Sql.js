// sql query parser

import { Box } from "@chakra-ui/react";

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

export default function Sql(key, text, colors, handlesetColors) {
  var columns = getColumnNames(text);
  var tables = getTableNames(text);
  var alias = {};
  for (var table in tables) {
    alias[tables[table]] = table;
  }
  // make a random color for each table as a dictionary
  Object.keys(tables).forEach((table) => {
    if (!colors[table]) {
      handlesetColors(table, randomColor());
    }
  });
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
            <Box
              backgroundColor={
                colors[
                  total_tables === 1
                    ? first_table
                    : alias[text.split(".")[0].toLowerCase()]
                ]
              }
              key={index}
              color="#fff"
              className="step"
            >
              {text}
            </Box>
          );
        } else return <></>;
      })}
    </div>
  );
}
