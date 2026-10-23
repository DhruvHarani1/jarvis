# Tokenise words into the BPE pieces the sherpa-onnx KWS models expect. Usage: python -I bpe.py <spm-dir> <bpe.model> "HEY JARVIS" ...
import sys
sys.path.insert(0, sys.argv[1])
import sentencepiece as spm
sp = spm.SentencePieceProcessor(model_file=sys.argv[2])
for phrase in sys.argv[3:]:
    print(' '.join(sp.encode(phrase.upper(), out_type=str)))
