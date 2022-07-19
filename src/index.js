import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { extendTheme, ChakraProvider } from '@chakra-ui/react'
import "./index.css";

// 2. Extend the theme to include custom colors, fonts, etc
const colors = {
  brand: {
    900: '#1a365d',
    800: '#153e75',
    700: '#2a69ac',
  },
}

const theme = extendTheme({ colors });

const root = ReactDOM.createRoot(document.getElementById("root"));

root.render(
    <ChakraProvider theme={theme}>
      <App />
    </ChakraProvider>
);
