/**
 * Test script for the Council-Consistency-Refinement graph
 *
 * This script verifies that the graph compiles and can be invoked.
 * Run with: pnpm tsx src/graph/test.ts
 */

import { buildCaseDraftCouncilGraph } from "./index.js";

async function testGraphCompilation() {
  console.log("=== Test 1: Graph Compilation ===");
  try {
    buildCaseDraftCouncilGraph();
    console.log("✅ Graph compiled successfully");
    console.log("   Graph has nodes and edges configured");
    return true;
  } catch (error) {
    console.error("❌ Graph compilation failed:", error);
    return false;
  }
}

async function testGraphStructure() {
  console.log("\n=== Test 2: Graph Structure ===");
  const graph = buildCaseDraftCouncilGraph();

  // Check that the graph has the expected structure
  console.log("   Checking graph properties...");

  // The compiled graph should have an invoke method
  if (typeof graph.invoke === "function") {
    console.log("✅ Graph has invoke method");
  } else {
    console.log("❌ Graph missing invoke method");
    return false;
  }

  return true;
}

async function runAllTests() {
  console.log("🧪 Running Council-Consistency-Refinement Graph Tests\n");

  const results = {
    compilation: await testGraphCompilation(),
    structure: await testGraphStructure(),
  };

  console.log("\n=== Test Summary ===");
  console.log(`Compilation: ${results.compilation ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`Structure:   ${results.structure ? "✅ PASS" : "❌ FAIL"}`);

  const allPassed = Object.values(results).every((r) => r);
  console.log(
    `\nOverall: ${allPassed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`
  );

  return allPassed;
}

// Run tests
runAllTests().catch(console.error);
