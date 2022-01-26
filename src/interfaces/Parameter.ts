import { ObjectInfo } from "./ObjectInfo";

export interface Parameter {
    isComplex: boolean,
    isConstant: boolean,
    memoryType: string,
    type: ObjectInfo[]
}