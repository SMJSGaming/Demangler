import { DynamicClass } from "std-node";

export class RegexStream {

    private input: string;

    private readonly ErrorClass: DynamicClass<Error>;

    constructor(input: string, ErrorClass: DynamicClass<Error>) {
        this.input = input;
        this.ErrorClass = ErrorClass;
    }

    public parse(regex: RegExp): RegExpExecArray {
        const parse = regex.exec(this.input);
        
        if (parse) {
            this.input = this.input.slice(parse.index + parse[0].length);

            return parse;
        } else {
            throw new this.ErrorClass();
        }
    }

    public test(regex: RegExp): boolean {
        return regex.test(this.input);
    }

    public leftOverLength(): number {
        return this.input.length;
    }
}