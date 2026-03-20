export type Patient = {
  name: string;
  age: number;
  height: number;
  weight: number;
  gender: "male" | "female";
  race?: string | undefined;
};
