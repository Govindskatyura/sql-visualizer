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
    <div className="App">
      {/* Section for sql visualization */}
      <div className="sql-visualization">
        <div className="sql-visualization-header">
          <h1>SQL Visualization</h1>
        </div>
        <div className="sql-visualization-body"></div>
        {/* Section to paste sql */}

        <div className="sql-visualization-header">
          <h1>Paste SQL</h1>
          <input
            type="text"
            className="sql-visualization-input"
            onChange={handleChange}
          />
          <button className="sql-visualization-button" onSubmit={handleSubmit}>
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
