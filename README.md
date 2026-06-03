# AetioMed

Welcome to AetioMed!

## Introduction

AetioMed is an advanced system designed to generate synthetic medical cases for educational and training purposes. By leveraging state-of-the-art Artificial Intelligence (Large Language Models), AetioMed creates realistic patient scenarios, including detailed anamnesis (medical history), chief complaints, and clinical context.

This tool aims to support medical educators and institutions in creating diverse and consistent training materials, ensuring high-quality resources for students and professionals.

## Table of Contents

1. [Introduction](#introduction)
2. [Features](#features)
3. [Plugin Architecture](#plugin-architecture)
4. [Generation Pipeline](#generation-pipeline)
   - [Symptoms](#symptoms)
   - [Single Field Generation](#single-field-generation)
   - [Multi Field Generation](#multi-field-generation)
   - [Translation](#translation)
   - [Previous Approaches](#previous-approaches)
5. [Developer Guide](README-DEV.md)

## Features

- **Automated Case Generation**: Instantly create detailed medical cases based on specific parameters or random generation.
- **Clinical Consistency**: Ensures that generated symptoms, history, and diagnoses are medically consistent.
- **Multi-stage Verification**: Uses a "Council" and "Consistency" review process to refine generated content.
- **Structured Data**: Outputs data in structured formats suitable for integration with other educational platforms.

## Plugin Architecture

## Generation Pipeline

### Symptoms

### Single Field Generation

1. generate a cot for the specific field if the llm model is a non thinking model
2. generate the field based on the cot.
   Any additional information like previous generated fields it should be consistent with, should be provided in the additional user instructions.

### Multi Field Generation

1. generate a cot for case generation only if the llm model is a non thinking model
2. generate an outline of the case. this should already include all the necessary details and relationships between the different fields
3. generate each field passed on the outline. this should mainly transform the outline into the structured output format and write it in the tone of the persona, but not add any additional information
4. make a consistency check of the generated fields to check if they are consistent with the outline and with each other. otherwise give explicit instructions on what to change to make them consistent.
5. generate the first iteration of procedures based on the case fields (patient, chiefComplaint, anamnesis). Generate the next iteration of procedures based on the previous procedures finding and case fields until convergence that a reliable diagnosis can be made.

### Translation

### Previous Approaches

#### Per Field Refinement

primary reason for doing pre field generation is persona and json structure. but refinement is only doing changes to already generated fields. therefore it should be easy for the model to keep the persona and structure.

## Developer Guide

For technical documentation, installation instructions, and contribution guidelines, please refer to the **[Developer Guide](README-DEV.md)**.
