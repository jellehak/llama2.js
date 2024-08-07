// About this code
// This is a JavaScript port of llama2.c, a tiny neural net language model

let config, vocab, vocab_scores, weights, run_state;
let is_generating = false;


/**
 * initialization: read from checkpoint
 * @param {*} path 
 */
export async function load_model(path = "") {
    const response = await fetch(path);
    const arrayBuffer = await response.arrayBuffer();

    readCheckpoint(arrayBuffer)
}

/**
 * initialization: read from checkpoint
 * @param {ArrayBuffer} arrayBuffer
 */
export async function readCheckpoint(arrayBuffer) {
    let offset = 0;

    config = {
        dim: 0, // transformer dimension
        hidden_dim: 0, // for ffn layers
        n_layers: 0, // number of layers
        n_heads: 0, // number of query heads
        n_kv_heads: 0, // number of key/value heads (can be < query heads because of multiquery)
        vocab_size: 0, // vocabulary size, usually 256 (byte-level)
        seq_len: 0, // max sequence length
    };

    let cfg_keys = Object.keys(config);
    new Int32Array(arrayBuffer.slice(0, offset += 4 * cfg_keys.length)).forEach((v, i) => {
        config[cfg_keys[i]] = v;
    });

    const p = config;
    // negative vocab size is hacky way of signaling unshared weights. bit yikes.
    const shared_weights = p.vocab_size > 0 ? 1 : 0;
    p.vocab_size = Math.abs(p.vocab_size);

    // initialization: read from checkpoint
    const head_size = p.dim / p.n_heads;
    weights = {
        // token embedding table
        token_embedding_table: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.vocab_size * p.dim)),
        // weights for rmsnorms
        rms_att_weight: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim)),
        // weights for matmuls
        wq: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim * p.dim)),
        wk: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim * p.dim)),
        wv: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim * p.dim)),
        wo: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim * p.dim)),
        // weights for rmsnorms
        rms_ffn_weight: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim)),
        // weights for ffn
        w1: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim * p.hidden_dim)),
        w2: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim * p.hidden_dim)),
        w3: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.n_layers * p.dim * p.hidden_dim)),
        // final rmsnorm
        rms_final_weight: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.dim)),
        // freq_cis for RoPE relatively positional embeddings
        freq_cis_real: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.seq_len * head_size / 2)),
        freq_cis_imag: new Float32Array(arrayBuffer.slice(offset, offset += 4 * p.seq_len * head_size / 2)),
        // (optional) classifier weights for the logits, on the last layer
        wcls: null,
    };
    weights.wcls = shared_weights ? weights.token_embedding_table : offset;

    run_state = {
        // current wave of activations
        x: new Float32Array(p.dim), // activation at current time stamp (dim,)
        xb: new Float32Array(p.dim), // same, but inside a residual branch (dim,)
        xb2: new Float32Array(p.dim), // an additional buffer just for convenience (dim,)
        hb: new Float32Array(p.hidden_dim), // buffer for hidden dimension in the ffn (hidden_dim,)
        hb2: new Float32Array(p.hidden_dim), // buffer for hidden dimension in the ffn (hidden_dim,)
        q: new Float32Array(p.dim), // query (dim,)
        k: new Float32Array(p.dim), // key (dim,)
        v: new Float32Array(p.dim), // value (dim,)
        att: new Float32Array(p.n_heads * p.seq_len), // buffer for scores/attention values (n_heads, seq_len)
        logits: new Float32Array(p.vocab_size), // output logits
        // kv cache
        key_cache: new Float32Array(p.n_layers * p.seq_len * p.dim),   // (layer, seq_len, dim)
        value_cache: new Float32Array(p.n_layers * p.seq_len * p.dim), // (layer, seq_len, dim)
    };
}

export async function load_vocab(path) {
    const response = await fetch(path);
    const arrayBuffer = await response.arrayBuffer();

    loadVocab(arrayBuffer)
}

export async function loadVocab(arrayBuffer) {
    const dataView = new DataView(arrayBuffer);
    let offset = 0;

    vocab = [];
    vocab_scores = [];
    const decoder = new TextDecoder();
    offset += 4;
    for (let i = 0; i < config.vocab_size; i++) {
        vocab_scores.push(dataView.getFloat32(offset, true));
        offset += 4;
        let len = dataView.getInt32(offset, true);
        offset += 4;
        vocab.push(decoder.decode(arrayBuffer.slice(offset, offset += len)));
    }
}


// ----------------------------------------------------------------------------
// neural net blocks

function accum(a, b, size) {
    for (let i = 0; i < size; i++) {
        a[i] += b[i];
    }
}

/**
 * calculate sum of squares
 * @param {*} o 
 * @param {*} x 
 * @param {*} weight 
 * @param {*} size 
 */
function rmsnorm(o, x, weight, size) {
    let ss = 0.0;
    for (let j = 0; j < size; j++) {
        ss += x[j] * x[j];
    }
    ss /= size;
    ss += 1e-5;
    ss = 1.0 / Math.sqrt(ss);
    // normalize and scale
    for (let j = 0; j < size; j++) {
        o[j] = weight[j] * (ss * x[j]);
    }
}

function softmax(x, size) {
    // find max value (for numerical stability)
    let max_val = x[0];
    for (let i = 1; i < size; i++) {
        if (x[i] > max_val) {
            max_val = x[i];
        }
    }
    // exp and sum
    let sum = 0.0;
    for (let i = 0; i < size; i++) {
        x[i] = Math.exp(x[i] - max_val);
        sum += x[i];
    }
    // normalize
    for (let i = 0; i < size; i++) {
        x[i] /= sum;
    }
}

function matmul(xout, x, w, n, d) {
    // W (d,n) @ x (n,) -> xout (d,)
    for (let i = 0; i < d; i++) {
        let val = 0.0;
        for (let j = 0; j < n; j++) {
            val += w[i * n + j] * x[j];
        }
        xout[i] = val;
    }
}

/**
 * 
 * @param {Number} token 
 * @param {*} pos config
 * @param {*} p 
 * @param {*} s run_state
 * @param {*} w weights
 */
function transformer(token = 0, pos, p, s, w) {
    // a few convenience variables
    let x = s.x;
    const dim = p.dim;
    const hidden_dim = p.hidden_dim;
    const head_size = dim / p.n_heads;

    // copy the token embedding into x
    x.set(w.token_embedding_table.subarray(token * dim, (token + 1) * dim));

    // pluck out the "pos" row of freq_cis_real and freq_cis_imag
    const freq_cis_real_row = w.freq_cis_real.subarray(pos * head_size / 2, (pos + 1) * head_size / 2);
    const freq_cis_imag_row = w.freq_cis_imag.subarray(pos * head_size / 2, (pos + 1) * head_size / 2);

    // forward all the layers
    for (let l = 0; l < p.n_layers; l++) {
        // attention rmsnorm
        rmsnorm(s.xb, x, w.rms_att_weight.subarray(l * dim, (l + 1) * dim), dim);

        // qkv matmuls for this position
        matmul(s.q, s.xb, w.wq.subarray(l * dim * dim, (l + 1) * dim * dim), dim, dim);
        matmul(s.k, s.xb, w.wk.subarray(l * dim * dim, (l + 1) * dim * dim), dim, dim);
        matmul(s.v, s.xb, w.wv.subarray(l * dim * dim, (l + 1) * dim * dim), dim, dim);

        // apply RoPE rotation to the q and k vectors for each head
        for (let h = 0; h < p.n_heads; h++) {
            // get the q and k vectors for this head
            const q = s.q.subarray(h * head_size, (h + 1) * head_size);
            const k = s.k.subarray(h * head_size, (h + 1) * head_size);
            // rotate q and k by the freq_cis_real and freq_cis_imag
            for (let i = 0; i < head_size; i += 2) {
                const q0 = q[i];
                const q1 = q[i + 1];
                const k0 = k[i];
                const k1 = k[i + 1];
                const fcr = freq_cis_real_row[i / 2];
                const fci = freq_cis_imag_row[i / 2];
                q[i] = q0 * fcr - q1 * fci;
                q[i + 1] = q0 * fci + q1 * fcr;
                k[i] = k0 * fcr - k1 * fci;
                k[i + 1] = k0 * fci + k1 * fcr;
            }
        }

        // save key,value at this time step (pos) to our kv cache
        const loff = l * p.seq_len * dim; // kv cache layer offset for convenience
        const key_cache_row = s.key_cache.subarray(loff + pos * dim, loff + (pos + 1) * dim);
        const value_cache_row = s.value_cache.subarray(loff + pos * dim, loff + (pos + 1) * dim);
        key_cache_row.set(s.k);
        value_cache_row.set(s.v);

        // multihead attention. iterate over all heads
        for (let h = 0; h < p.n_heads; h++) {
            // get the query vector for this head
            const q = s.q.subarray(h * head_size, (h + 1) * head_size);
            // attention scores for this head
            const att = s.att.subarray(h * p.seq_len, (h + 1) * p.seq_len);
            // iterate over all timesteps, including the current one
            for (let t = 0; t <= pos; t++) {
                // get the key vector for this head and at this timestep
                const k = s.key_cache.subarray(loff + t * dim + h * head_size, loff + (t + 1) * dim + h * head_size);
                // calculate the attention score as the dot product of q and k
                let score = 0.0;
                for (let i = 0; i < head_size; i++) {
                    score += q[i] * k[i];
                }
                score /= Math.sqrt(head_size);
                // save the score to the attention buffer
                att[t] = score;
            }

            // softmax the scores to get attention weights, from 0..pos inclusively
            softmax(att, pos + 1);

            // weighted sum of the values, store back into xb
            for (let i = 0; i < head_size; i++) {
                let val = 0.0;
                for (let t = 0; t <= pos; t++) {
                    val += att[t] * s.value_cache[loff + t * dim + h * head_size + i]; // note bad locality
                }
                s.xb[h * head_size + i] = val;
            }
        }

        // final matmul to get the output of the attention
        matmul(s.xb2, s.xb, w.wo.subarray(l * dim * dim, (l + 1) * dim * dim), dim, dim);

        // residual connection back into x
        accum(x, s.xb2, dim);

        // ffn rmsnorm
        rmsnorm(s.xb, x, w.rms_ffn_weight.subarray(l * dim, (l + 1) * dim), dim);

        // Now for FFN in PyTorch we have: self.w2(F.silu(self.w1(x)) * self.w3(x))
        // first calculate self.w1(x) and self.w3(x)
        matmul(s.hb, s.xb, w.w1.subarray(l * dim * hidden_dim, (l + 1) * dim * hidden_dim), dim, hidden_dim);
        matmul(s.hb2, s.xb, w.w3.subarray(l * dim * hidden_dim, (l + 1) * dim * hidden_dim), dim, hidden_dim);

        // F.silu; silu(x)=x*σ(x),where σ(x) is the logistic sigmoid
        for (let i = 0; i < hidden_dim; i++) {
            s.hb[i] = s.hb[i] * (1.0 / (1.0 + Math.exp(-s.hb[i])));
        }

        // elementwise multiply with w3(x)
        for (let i = 0; i < hidden_dim; i++) {
            s.hb[i] = s.hb[i] * s.hb2[i];
        }

        // final matmul to get the output of the ffn
        matmul(s.xb, s.hb, w.w2.subarray(l * dim * hidden_dim, (l + 1) * dim * hidden_dim), hidden_dim, dim);

        // residual connection
        accum(x, s.xb, dim);
    }

    // final rmsnorm
    rmsnorm(x, x, w.rms_final_weight, dim);

    // classifier into logits
    matmul(s.logits, x, w.wcls, p.dim, p.vocab_size);
}

/**
 * byte pair encoding (BPE) tokenizer, encodes strings into tokens so we can prompt
 * @param {*} text 
 * @returns 
 */
function bpe_encode(text) {

    // a temporary buffer to merge two consecutive tokens
    let str_buffer = ''; // *2 for concat, +1 for null terminator

    // first encode every individual byte in the input string
    let n_tokens = 0; // the number of tokens
    let tokens = [];
    for (let c of text) {
        let id = vocab.indexOf(c);
        if (id == -1) { console.log("not good\n"); }
        tokens.push(id);
        n_tokens++;
    }

    // merge the best consecutive pair each iteration, according the scores in vocab_scores
    while (1) {
        let best_score = -1e10;
        let best_id = -1;
        let best_idx = -1;

        for (let i = 0; i < (n_tokens - 1); i++) {
            // check if we can merge the pair (tokens[i], tokens[i+1])
            str_buffer = vocab[tokens[i]] + vocab[tokens[i + 1]];
            let id = vocab.indexOf(str_buffer);
            if (id != -1 && vocab_scores[id] > best_score) {
                // this merge pair exists in vocab! record its score and position
                best_score = vocab_scores[id];
                best_id = id;
                best_idx = i;
            }
        }

        if (best_idx == -1) {
            break; // we couldn't find any more pairs to merge, so we're done
        }

        // merge the consecutive pair (best_idx, best_idx+1) into new token best_id
        tokens[best_idx] = best_id;
        // delete token at position best_idx+1, shift the entire sequence back 1
        for (let i = best_idx + 1; i < (n_tokens - 1); i++) {
            tokens[i] = tokens[i + 1];
        }
        n_tokens--; // token length decreased
    }

    return tokens.slice(0, n_tokens);
}

// ----------------------------------------------------------------------------

function sample(probabilities, n) {
    // sample index from probabilities, they must sum to 1
    const r = Math.random();
    let cdf = 0.0;
    for (let i = 0; i < n; i++) {
        cdf += probabilities[i];
        if (r < cdf) {
            return i;
        }
    }
    return n - 1; // in case of rounding errors
}

function sample_topp(probabilities, n, topp) {
    // top-p sampling (or "nucleus sampling") samples from the smallest set of
    // tokens that exceed probability topp. This way we never sample tokens that
    // have very low probabilities and are less likely to go "off the rails".

    // quicksort indices in descending order of probabilities
    // values smaller than (1 - topp) / (n - 1) cannot be part of the result
    // so for efficiency we crop these out as candidates before sorting
    const cutoff = (1.0 - topp) / (n - 1);
    let n0 = 0;
    let probindex = [];
    for (let i = 0; i < n; i++) {
        if (probabilities[i] >= cutoff) {
            probindex.push({ index: i, prob: probabilities[i] });
            n0++;
        }
    }
    probindex.sort((a, b) => b.prob - a.prob);

    // truncate the list where cumulative probability exceeds topp
    let cumulative_prob = 0.0;
    let last_idx = n0 - 1; // in case of rounding errors consider all elements
    for (let i = 0; i < n0; i++) {
        cumulative_prob += probindex[i].prob;
        if (cumulative_prob > topp) {
            last_idx = i;
            break; // we've exceeded topp by including last_idx
        }
    }

    // sample from the truncated list
    const r = Math.random() * cumulative_prob;
    let cdf = 0.0;
    for (let i = 0; i <= last_idx; i++) {
        cdf += probindex[i].prob;
        if (r < cdf) {
            return probindex[i].index;
        }
    }
    return probindex[last_idx].index; // in case of rounding errors
}

function argmax(v, n) {
    // return argmax of v in elements 0..n
    let max_i = 0;
    let max_p = v[0];
    for (let i = 1; i < n; i++) {
        if (v[i] > max_p) {
            max_i = i;
            max_p = v[i];
        }
    }
    return max_i;
}

function step({isInputPrompt, prompt_tokens, pos, temperature, topp}) {
    let next = 0

    if (isInputPrompt) {
        // if we are still processing the input prompt, force the next prompt token
        next = prompt_tokens[pos];
        return next;
    }

    // sample the next token
    const isTemperatureZero = temperature == 0.0;
    if (isTemperatureZero) {
        // greedy argmax sampling
        next = argmax(run_state.logits, config.vocab_size);
        return next;
    }

    if(!isTemperatureZero) {
        // apply the temperature to the logits
        for (let q = 0; q < config.vocab_size; q++) { run_state.logits[q] /= temperature; }
        // apply softmax to the logits to get the probabilities for next token
        softmax(run_state.logits, config.vocab_size);

        // we now want to sample from this distribution to get the next token
        if (topp <= 0 || topp >= 1) {
            // simply sample from the predicted probability distribution
            next = sample(run_state.logits, config.vocab_size);
        } else {
            // top-p (nucleus) sampling, clamping the least likely tokens to zero
            next = sample_topp(run_state.logits, config.vocab_size, topp);
        }
    }
    return next;
}

/**
 * 
 * @param {*} param0 
 * @returns 
 */
export async function *generator({
    temperature = 1.0,
    topp = 1.0,
    steps = 100,
    prompt = ''
} = {}) {
    if (is_generating) {
        return;
    }
    is_generating = true;
    
    let elpased = [];

    let pos = 0;
    // right now we cannot run for more than p.seq_len steps
    if (steps <= 0 || steps > config.seq_len) { steps = config.seq_len; }
    let token = 1; // 1 = BOS token in Llama-2 sentencepiece

    let num_prompt_tokens = 0;
    const prompt_tokens = bpe_encode(prompt);
    num_prompt_tokens = prompt_tokens.length;
   
    while (pos < steps) {
        const start = performance.now();
        transformer(token, pos, config, run_state, weights);

        const isInputPrompt = pos < num_prompt_tokens;

        const next = step({isInputPrompt, prompt_tokens, pos, temperature, topp})

        // Delay for 0ms to allow the UI to update
        await new Promise(resolve => setTimeout(resolve, 0));

        // advance forward
        token = next;
        pos++;
        // report achieved tok/s
        const end = performance.now();
        elpased.push(1 / (end - start) * 1000);
        yield {
            isInputPrompt,
            next: vocab[next], 
            token, 
            toks: elpased.slice(-1)[0] 
        };
    }
    const avg = elpased.reduce((a, b) => a + b) / elpased.length;
    is_generating = false;
    return {avg}
}
