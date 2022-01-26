import { BetterObject, callback, Stringifyer } from "std-node";

import { TYPES } from "../constants/TYPES";
import { REGEX_TYPES } from "../constants/REGEX_TYPES";
import { SECTION_ORDER } from "../constants/SECTION_ORDER";
import { NotMangledError } from "../errors/NotMangledError";
import { Parameter } from "../interfaces/Parameter";
import { ObjectInfo } from "../interfaces/ObjectInfo";
import { ClassMethodInfo } from "../interfaces/ClassMethodInfo";
import { RegexStream } from "./RegexStream";

export class Demangler implements Stringifyer {

    public readonly isType: boolean;

    public readonly isVTable: boolean;

    public readonly isTypeStructure: boolean;

    public readonly isTypeName: boolean;

    public readonly isNonVirtualThunk: boolean;

    public readonly thunkOffset: number | null;

    public readonly isConstant: boolean;

    public readonly isClassConstructor: boolean;

    public readonly isClassDestructor: boolean;

    public readonly objects: ObjectInfo[];

    public readonly parameters: Parameter[];

    public readonly sections: (ObjectInfo[] | Parameter)[];

    private readonly stream: RegexStream;

    constructor(mangled: string) {
        this.stream = new RegexStream(mangled, NotMangledError);

        const [
            _,
            isType,
            typeId,
            offset,
            isConstant,
            initialLength
        ] = this.stream.parse(new RegExp(`^_Z(?:(T)(V|I|S|hn(\\d+)_))?N?(K)?(\\d*)`));
        const objectInfo: ClassMethodInfo = {
            isConstructor: false,
            isDestructor: false
        };

        this.isType = Boolean(isType);
        this.isVTable = typeId == "V";
        this.isTypeStructure = typeId == "I";
        this.isTypeName = typeId == "S";
        this.isNonVirtualThunk = typeId != undefined && typeId.startsWith("hn");
        this.thunkOffset = parseInt(offset) || null;
        this.isConstant = Boolean(isConstant);
        this.sections = [];
        this.objects = [ ...this.getObjects(parseInt(initialLength), objectInfo) ];
        this.sections.push(...this.objects.map((section, index) => [ ...this.objects.slice(0, index), section ]).slice(1, -1));
        this.isClassConstructor = objectInfo.isConstructor;
        this.isClassDestructor = objectInfo.isDestructor;

        if (this.isType && !this.isNonVirtualThunk) {
            this.parameters = [];
        } else {
            // Remove leftover end indicators
            this.stream.parse(/^E{0,1}/);
            this.parameters = [ ...this.getParameters() ];
        }
    }

    public toString(): string {
        const object = this.stringifyObject(this.objects, this.isNonVirtualThunk);

        return [
            this.isVTable ? "struct " : this.isTypeName ? "struct " : this.isTypeStructure ? "struct : public struct " : "",
            object,
            this.isVTable ? " : public struct" : "",
            this.isType && !this.isNonVirtualThunk ? " { }" : [
                "(",
                this.stringifyParameters(this.parameters, this.isNonVirtualThunk, false),
                ")",
                this.isConstant ? " const" : ""
            ].join(""),
            this.isNonVirtualThunk ? [
                " {\n\t(this - ",
                this.thunkOffset,
                ")->",
                object.replace(/<(?:[^>].)+?>$$/, (str) => `<${str.split(", ").map((_, index) => `T${index}`).join(", ")}>`),
                "(",
                Array(this.parameters.length).fill("").map((_, index) => `p${index}`).join(", "),
                ");\n}"
            ].join("") : ";"
        ].join("");
    }

    private stringifyObject(objectInfos: ObjectInfo[], isFull: boolean): string {
        return objectInfos.map((objectInfo, index) => objectInfo.object + (objectInfo.templates.length ?
            `<${this.stringifyParameters(objectInfo.templates, isFull && index == objectInfos.length - 1, true)}>` : "")).join("::");
    }

    private stringifyParameters(parameters: Parameter[], isFull: boolean, isTemplate: boolean): string {
        return parameters.map((parameter, index) => [
            parameter.isComplex ? "complex " : "",
            this.stringifyObject(parameter.type, false),
            isFull ? (isTemplate ? " T" : " p") + index : "",
            parameter.isConstant ? " const" : parameter.memoryType ? " " : "",
            parameter.memoryType
        ].join("")).join(", ");
    }

    private getObjects(initialLength: number, specialInfo?: ClassMethodInfo): ObjectInfo[] {
        const objects: ObjectInfo[] = [];
        const isStd = this.stream.test(/^(Sa|Sb|Sd|Si|So|Ss|St)/);

        if (!isNaN(initialLength) || isStd) {
            this.objectParser(isStd ? 2 : initialLength, ([ _, object, hasTemplate, nextLength, specialMethod ]) => {
                objects.push({
                    object: objects.length == 0 && isStd ? TYPES.get(object)! : object,
                    templates: hasTemplate ? this.getParameters() : []
                });

                if (!nextLength) {
                    if (specialMethod) {
                        const isConstructor = specialMethod == "C";

                        if (specialInfo) {
                            specialInfo.isConstructor = specialMethod == "C";
                            specialInfo.isDestructor = specialMethod == "D";
                        }

                        objects.push({
                            object: (isConstructor ? "" : "~") + object,
                            templates: []
                        });
                    }
                }
            });
        }

        return objects;
    }

    private objectParser(length: number, handler: (match: RegExpExecArray, end: callback<void>) => void): void {
        let match: RegExpExecArray;
        let ongoing = true;

        while (this.stream.leftOverLength() && ongoing && (match = this.stream.parse(new RegExp(`^(\\w{${length}})(?:(I)|(?:(\\d+)|(D|C)?\\d*))`)))) {
            const nextLength = parseInt(match[3]);

            handler(match, () => ongoing = false);

            if (isNaN(nextLength) && (match[2] != "I" || !(match = this.stream.parse(/^\d*/))[0])) {
                ongoing = false;
            } else {
                length = nextLength || parseInt(match[0]);
            }

        }
    }

    private getParameters(): Parameter[] {
        const parameters: Parameter[] = [];

        this.parameterParser(([ _, memoryTypeChars, isConstant, isComplex, type, substitute, next ]) => {
            const staticType = TYPES.get(type);
            const nextLength = parseInt(next);
            const objects: ObjectInfo[] = [];
            const parameter: Parameter = {
                isComplex: Boolean(isComplex),
                isConstant: Boolean(isConstant),
                memoryType: memoryTypeChars.replace(/P/g, "*").replace(/R/g, "&"),
                type: []
            };

            if (staticType) {
                objects.push({
                    object: staticType,
                    templates: next == "I" ? this.getParameters() : []
                });
            } else if (type.startsWith("S")) {
                const substituteNumber = parseInt(substitute);
                const isInvalidNumber = isNaN(substituteNumber);

                if (isInvalidNumber && this.objects.length > 1) {
                    objects.push(this.objects[0]);
                } else if (this.sections.length) {
                    const original = this.sections[substituteNumber] || this.sections[this.sections.length - 1];
                    const isArray = Array.isArray(original);
                    const source = Object.assign(isArray ? [] : {}, original);

                    if (source) {
                        if (isArray) {
                            objects.push(...<ObjectInfo[]>source);
                        } else {
                            BetterObject.softMerge(parameter, source);

                            objects.push(...(<Parameter>source).type);
                        }
                    } else {
                        throw new NotMangledError();
                    }
                }
            }

            if (!isNaN(nextLength)) {
                objects.push(...this.getObjects(nextLength));
            }

            if (objects.length) {
                parameter.type = objects;
            } else {
                throw new NotMangledError();
            }

            parameters.push(parameter);

            this.sections.push(...this.parameterSectionSplitter(parameter, parameter.type.length == 1));
        });

        return parameters;
    }

    private parameterParser(handler: (match: RegExpExecArray, end: callback<void>) => void): void {
        let match: RegExpExecArray;
        let ongoing = true;

        while (this.stream.leftOverLength() && ongoing && (match = this.stream.parse(new RegExp(`^([PR]*)(K)?(C)?N?(?:E|(${REGEX_TYPES}|S(\\d*)_)(I|\\d*))`)))) {
            if (match[0] == "E") {
                ongoing = false;
            } else {
                handler(match, () => ongoing = false);
            }
        }
    }

    private parameterSectionSplitter(parameter: Parameter, basicType: boolean): Parameter[] {
        /*
            Section order:

            - Base
            - Types in the templates which start from Base order wise
            - Templates
            - Complex
            - Const
            - Pointer/Reference separately in order

            If it's a basic type (aka a type which doesn't have following objects) the first section will be force included, the following will be the remaining sections
        */
        const sections: Parameter[] = [];

        sections.push({
            isComplex: false,
            isConstant: false,
            memoryType: "",
            type: parameter.type.map(({ object }) => ({
                object,
                templates: []
            }))
        });

        if (parameter.type.some((objectInfo) => objectInfo.templates.length)) {
            const source = Object.assign({}, sections[0]);

            source.type = parameter.type;

            sections.push(source);
        }

        SECTION_ORDER.filter((typeInfo) => parameter[typeInfo]?.length ?? parameter[typeInfo]).forEach((typeInfo) => {
            const source = Object.assign({}, sections[sections.length - 1]);

            if (typeof source[typeInfo] == "boolean") {
                source[typeInfo] = true;
            } else if (typeof source[typeInfo] == "string") {
                parameter[typeInfo].split("").forEach((_, index, array) => {
                    const extraSource = Object.assign({}, source);

                    extraSource[typeInfo] = array.slice(0, index + 1).join("");

                    sections.push(extraSource);
                });

                return;
            } else {
                source[typeInfo] = parameter[typeInfo];
            }

            sections.push(source);
        });

        if (basicType) {
            sections.shift();
        }

        return sections;
    }
}