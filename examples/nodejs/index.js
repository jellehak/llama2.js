import { loadVocab, readCheckpoint, generator } from "../../llama2.js"
import * as process from 'process'
import * as fs from 'fs'

async function init() {
    // await load_model("../../models/stories15m.bin")
    const model = fs.readFileSync('../../models/stories15m.bin')
    readCheckpoint(model.buffer)
    // await load_vocab("../../tokenizer.bin")
    const tokenizer = fs.readFileSync('../../tokenizer.bin')
    loadVocab(tokenizer.buffer)

    generate()
}

async function generate() {
    const iterator = await generator({
        prompt: "Once upon a time, there was a"
    })

    while (true) {
        const { value, done } = await iterator.next() 
        if (done) {
            console.log(value)
            break
        }
        process.stdout.write(value.next)
    }
}

init()
