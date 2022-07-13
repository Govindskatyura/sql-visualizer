import { Button, Container, Input, Stack } from "@chakra-ui/react";
import { useState } from "react";

function App() {
  const [sql, setSql] = useState("");
  function handleChange(e) {
    setSql(e.target.value);
  }
  function handleSubmit(e) {
    e.preventDefault();
    console.log(sql);
  }
  return (
    <Container>
      {/* Section for sql visualization */}
      <div className="sql-visualization">
        <div className="sql-visualization-header">
          <h1>SQL Visualization</h1>
        </div>
        <div className="sql-visualization-body"></div>
        {/* Section to paste sql */}

        <div className="sql-visualization-header">
          <h1>Paste SQL</h1>
          <Input
            variant="outline"
            placeholder="Outline"
            type="text"
            onChange={handleChange}
            value={sql}
            size='lg'
          />
          <Stack spacing={4} mt={3} direction="row" align="center" justifyContent={'center'}>
            <Button
              className="sql-visualization-button"
              onSubmit={handleSubmit}
              colorScheme="blue"
              alignContent="center"
            >
              Submit
            </Button>
            <Button
              className="sql-visualization-button"
              onSubmit={handleSubmit}
              colorScheme="blue"
              alignContent="center"
            >
              Reset
            </Button>
          </Stack>
        </div>
      </div>
    </Container>
  );
}

export default App;
