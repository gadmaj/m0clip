#!/usr/bin/env python3
"""Shape-faithful MNN -> ONNX converter.

A naive converter that flattens every tensor to [1, N] is fine for plain MLPs but cannot express the
LayerNorm reductions over [1, T, F] histories (ai_sport VQ decoders / estimators) or the time-indexed
motion tables of the get-up nets (Cast + GatherV2). This converter instead:

  1. runs the MNN graph in numpy with the real input shapes, so every tensor gets a concrete shape;
  2. folds everything that does not depend on input VALUES (Shape/Rank/Range sub-graphs, constants,
     reshape targets) into ONNX initializers;
  3. emits ONNX nodes, with real ranks, for the value-dependent part of the graph;
  4. checks the ONNX output against MNN itself on random inputs.

usage: mnn_graph_to_onnx.py model.mnn [more.mnn ...] [--out model.onnx]   (default: <model>.onnx next to it)
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys, tempfile
import numpy as np


def _mnn_to_json(mnn_path):
    """The MNN graph as json (`mnnconvert -f MNN --JsonFile`; mnnconvert comes with the MNN pip package)."""
    fd, jp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        subprocess.run(["mnnconvert", "-f", "MNN", "--modelFile", mnn_path, "--JsonFile", jp],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(jp) as f:
            return json.load(f)
    finally:
        os.remove(jp)


BIN = {0: "ADD", 1: "SUB", 2: "MUL", 3: "DIV", 4: "MAX_TEMP", 5: "MIN_TEMP", 6: "POW", 7: "REALDIV",
       8: "MINIMUM", 9: "MAXIMUM", 10: "GREATER", 11: "GREATER_EQUAL", 12: "LESS", 13: "FLOORDIV",
       14: "SquaredDifference", 15: "EQUAL", 16: "LESS_EQUAL", 17: "FLOORMOD", 19: "MOD"}
UN = {0: "ABS", 1: "NEG", 2: "FLOOR", 3: "CEIL", 4: "SQUARE", 5: "SQRT", 6: "RSQRT", 7: "EXP", 8: "LOG",
      9: "SIN", 10: "COS", 11: "TAN", 12: "ASIN", 13: "ACOS", 14: "ATAN", 15: "RECIPROCAL", 16: "LOG1P",
      17: "BNLL", 18: "ACOSH", 19: "SINH", 20: "ASINH", 21: "ATANH", 22: "SIGN", 23: "ROUND", 24: "COSH",
      25: "ERF", 26: "ERFC", 27: "ERFINV", 28: "EXPM1", 29: "SIGMOID", 30: "TANH", 31: "HARDSWISH", 32: "GELU"}
NP_DT = {"DT_INT32": np.int32, "DT_INT64": np.int64, "DT_FLOAT": np.float32, "DT_BOOL": np.bool_}


def _const_value(m):
    dims = [int(x) for x in (m.get("dims") or [])]
    for key, dt in (("float32s", np.float32), ("int32s", np.int32), ("int64s", np.int64), ("uint8s", np.uint8)):
        if key in m and m[key] is not None:
            v = np.array(m[key], dt)
            return v.reshape(dims) if dims and v.size == int(np.prod(dims)) else (v.reshape(()) if not dims and v.size == 1 else v)
    return np.zeros(dims, np.float32)


def _probe_conv_weights(mnn_path, d, op, x_shape):
    """Dense float weights of a 1x1 conv whose weights MNN stores compressed (quanParameter / sparseParameter,
    not expanded by the json dump): run just this layer inside MNN (sub-graph between named tensors) on unit
    inputs.  Returns W [cout, cin], b [cout]."""
    import MNN, MNN.expr as F
    names, ops = d["tensorName"], d["oplists"]
    src = op["inputIndexes"][0]
    prod = {oi: o for o in ops for oi in (o.get("outputIndexes") or [])}
    if prod.get(src, {}).get("type") == "ConvertTensor":      # feed the NCHW tensor before the layout convert
        src = prod[src]["inputIndexes"][0]
    dst = op["outputIndexes"][0]
    for o in ops:
        if o["type"] == "ConvertTensor" and (o.get("inputIndexes") or [None])[0] == dst:
            dst = o["outputIndexes"][0]
    mod = MNN.nn.load_module_from_file(mnn_path, [names[src]], [names[dst]])
    cin = int(np.prod(x_shape[1:]))
    def run(v):
        y = mod.forward([F.const(v.reshape(-1).tolist(), list(x_shape), F.NCHW)])
        y = y[0] if isinstance(y, (list, tuple)) else y
        return np.array(y.read(), np.float32).reshape(-1)
    b = run(np.zeros(x_shape, np.float32))
    W = np.stack([run(np.eye(cin, dtype=np.float32)[i].reshape(x_shape)) - b for i in range(cin)], axis=1)
    return W, b


class Converter:
    def __init__(self, d, mnn_path=None):
        self.mnn_path = mnn_path
        from onnx import helper, numpy_helper, TensorProto
        self.h, self.nh, self.TP = helper, numpy_helper, TensorProto
        self.d = d
        self.names = d["tensorName"]
        self.val = {}        # tensor index -> numpy sample value
        self.dyn = set()     # tensor indices whose value depends on graph inputs
        self.onnx = {}       # tensor index -> onnx tensor name (dynamic tensors only)
        self.nodes, self.inits = [], []
        self.n = 0

    def _u(self, p):
        self.n += 1
        return f"{p}_{self.n}"

    def _init(self, arr):
        """ONNX initializer for a static numpy value (ints -> int64)."""
        a = np.asarray(arr)
        if a.dtype.kind in "iu" or a.dtype == np.bool_:
            a = a.astype(np.int64) if a.dtype != np.bool_ else a
        elif a.dtype != np.float32:
            a = a.astype(np.float32)
        nm = self._u("c")
        self.inits.append(self.nh.from_array(a, nm))
        return nm

    def src(self, idx, as_int=False):
        """ONNX name for tensor idx (static tensors become initializers on demand)."""
        if idx in self.dyn:
            return self.onnx[idx]
        v = self.val[idx]
        if as_int:
            v = np.asarray(v).astype(np.int64)
        return self._init(v)

    def node(self, op, ins, oidx, **attrs):
        y = self._u(op.lower())
        self.nodes.append(self.h.make_node(op, ins, [y], **attrs))
        self.onnx[oidx] = y
        self.dyn.add(oidx)
        return y

    # ---- numpy semantics + onnx emission per MNN op -----------------------------------------------
    def run(self, feeds):
        ops = self.d["oplists"]
        done = set()
        for oi, (nm, arr) in feeds.items():
            self.val[oi] = arr
            self.dyn.add(oi)
            self.onnx[oi] = nm
        pending = [op for op in ops if op["type"] != "Input"]
        while pending:
            progressed = False
            rest = []
            for op in pending:
                ii = op.get("inputIndexes") or []
                if all(i in self.val for i in ii):
                    self.apply(op)
                    progressed = True
                else:
                    rest.append(op)
            if not progressed:
                raise ValueError("graph has unresolvable inputs: " + ", ".join(o["type"] for o in rest[:5]))
            pending = rest

    def apply(self, op):
        t, m = op["type"], (op.get("main") or {})
        ii, oo = op.get("inputIndexes") or [], op.get("outputIndexes") or []
        V = [self.val[i] for i in ii]
        D = any(i in self.dyn for i in ii)
        o = oo[0] if oo else None

        def keep(v, emit):
            self.val[o] = v
            if D:
                emit()

        if t == "Const":
            self.val[o] = _const_value(m)
        elif t in ("Shape",):
            self.val[o] = np.array(np.shape(V[0]), np.int32)
        elif t == "Rank":
            self.val[o] = np.array(np.ndim(V[0]), np.int32)
        elif t == "Size":
            self.val[o] = np.array(np.size(V[0]), np.int32)
        elif t == "Range":
            self.val[o] = np.arange(np.asarray(V[0]).item(), np.asarray(V[1]).item(), np.asarray(V[2]).item()).astype(np.int32)
        elif t == "ConvertTensor":
            self.val[o] = V[0]
            if D: self.onnx[o] = self.onnx[ii[0]]; self.dyn.add(o)
        elif t in ("Unsqueeze", "Squeeze"):
            axes = [int(a) for a in (m.get("squeezeDims") or [])]
            if len(ii) > 1:
                axes = [int(a) for a in np.atleast_1d(V[1])]
            x = V[0]
            if t == "Unsqueeze":
                v = x
                for a in sorted(a if a >= 0 else a + np.ndim(x) + len(axes) for a in axes):
                    v = np.expand_dims(v, a)
            else:
                v = np.squeeze(x, axis=tuple(axes)) if axes else np.squeeze(x)
            keep(v, lambda: self.node("Reshape", [self.onnx[ii[0]], self._init(np.array(v.shape, np.int64))], o))
        elif t == "Reshape":
            shape = [int(s) for s in np.atleast_1d(V[1])] if len(ii) > 1 else [int(s) for s in m.get("dims", [])]
            x = V[0]
            shape = [x.shape[k] if s == 0 and k < x.ndim else s for k, s in enumerate(shape)]
            v = np.reshape(x, shape)
            keep(v, lambda: self.node("Reshape", [self.onnx[ii[0]], self._init(np.array(v.shape, np.int64))], o))
        elif t == "Flatten":
            ax = int(m.get("axis", 1))
            x = V[0]; v = x.reshape(int(np.prod(x.shape[:ax])), -1)
            keep(v, lambda: self.node("Reshape", [self.onnx[ii[0]], self._init(np.array(v.shape, np.int64))], o))
        elif t in ("Convolution", "InnerProduct"):
            cm = m.get("common", {})
            cout, cin = int(cm.get("outputCount", m.get("outputCount", 0))), int(cm.get("inputCount", 0))
            if m.get("weight") is None:            # compressed weights: recover them numerically from MNN
                cm_relu = cm.get("relu") or cm.get("relu6")
                assert not cm_relu, "probing a conv with a fused activation is not supported"
                W, b_probe = _probe_conv_weights(self.mnn_path, self.d, op, V[0].shape)
                m = dict(m, weight=W.reshape(-1).tolist(), bias=b_probe.tolist())
                cin = W.shape[1]
            W = np.array(m["weight"], np.float32)
            cin = cin or W.size // cout
            kx, ky = int(cm.get("kernelX", 1)), int(cm.get("kernelY", 1))
            assert kx == 1 and ky == 1 and int(cm.get("group", 1)) == 1, "only 1x1 convolutions are supported"
            W = W.reshape(cout, cin)
            b = np.array(m.get("bias") or [0.0] * cout, np.float32)
            x = V[0].astype(np.float32)
            v = np.einsum("oc,nc...->no...", W, x) + b.reshape((1, cout) + (1,) * (x.ndim - 2))
            relu, relu6 = cm.get("relu"), cm.get("relu6")
            if relu: v = np.maximum(v, 0)
            if relu6: v = np.clip(v, 0, 6)
            def emit():
                y = self.node("Conv", [self.onnx[ii[0]], self._init(W.reshape(cout, cin, *([1] * (x.ndim - 2)))), self._init(b)], o)
                if relu: self.node("Relu", [y], o)
                if relu6: self.node("Clip", [y, self._init(np.float32(0)), self._init(np.float32(6))], o)
            keep(v.astype(np.float32), emit)
        elif t == "BinaryOp":
            code = m.get("opType", 0)
            code = BIN.get(code, code) if isinstance(code, int) else code
            a, b = V
            fn = {"ADD": np.add, "SUB": np.subtract, "MUL": np.multiply, "DIV": np.divide, "REALDIV": np.divide,
                  "POW": np.power, "MINIMUM": np.minimum, "MAXIMUM": np.maximum, "MAX_TEMP": np.maximum,
                  "MIN_TEMP": np.minimum, "SquaredDifference": lambda x, y: (x - y) ** 2,
                  "GREATER": np.greater, "GREATER_EQUAL": np.greater_equal, "LESS": np.less,
                  "LESS_EQUAL": np.less_equal, "EQUAL": np.equal, "FLOORDIV": np.floor_divide,
                  "FLOORMOD": np.mod, "MOD": np.fmod}[code]
            isint = np.asarray(a).dtype.kind in "iu" and np.asarray(b).dtype.kind in "iu"
            v = fn(a, b)
            if code in ("DIV", "REALDIV") and isint: v = np.floor_divide(a, b)
            onx = {"ADD": "Add", "SUB": "Sub", "MUL": "Mul", "DIV": "Div", "REALDIV": "Div", "POW": "Pow",
                   "MINIMUM": "Min", "MAXIMUM": "Max", "MAX_TEMP": "Max", "MIN_TEMP": "Min",
                   "GREATER": "Greater", "LESS": "Less", "EQUAL": "Equal"}.get(code)
            def emit():
                A, B = self.src(ii[0]), self.src(ii[1])
                if code == "SquaredDifference":
                    s = self.node("Sub", [A, B], o); self.node("Mul", [s, s], o)
                elif onx:
                    self.node(onx, [A, B], o)
                else:
                    if code in ("MOD", "FLOORMOD"):   # int mod -> onnx Mod (python sign), float -> fmod
                        self.node("Mod", [A, B], o, fmod=0 if isint else 1)
                    else:
                        raise ValueError(f"BinaryOp {code} on dynamic tensors not supported")
            keep(v.astype(np.float32) if not isint else v, emit)
        elif t == "UnaryOp":
            code = m.get("opType", 0)
            code = UN.get(code, code) if isinstance(code, int) else code
            x = V[0]
            fn = {"ABS": np.abs, "NEG": np.negative, "SQUARE": np.square, "SQRT": np.sqrt, "RSQRT": lambda z: 1 / np.sqrt(z),
                  "EXP": np.exp, "LOG": np.log, "RECIPROCAL": lambda z: 1 / z, "SIGMOID": lambda z: 1 / (1 + np.exp(-z)),
                  "TANH": np.tanh, "FLOOR": np.floor, "CEIL": np.ceil, "SIN": np.sin, "COS": np.cos, "ROUND": np.round}[code]
            v = fn(x.astype(np.float32))
            def emit():
                s = self.onnx[ii[0]]
                if code == "SQUARE": self.node("Mul", [s, s], o)
                elif code == "RSQRT": r = self.node("Sqrt", [s], o); self.node("Reciprocal", [r], o)
                else:
                    self.node({"ABS": "Abs", "NEG": "Neg", "SQRT": "Sqrt", "EXP": "Exp", "LOG": "Log",
                               "RECIPROCAL": "Reciprocal", "SIGMOID": "Sigmoid", "TANH": "Tanh", "FLOOR": "Floor",
                               "CEIL": "Ceil", "SIN": "Sin", "COS": "Cos", "ROUND": "Round"}[code], [s], o)
            keep(v.astype(np.float32), emit)
        elif t == "Reduction":
            opn = m.get("operation", "SUM")
            axes = [int(a) for a in np.atleast_1d(V[1])] if len(ii) > 1 else [int(a) for a in (m.get("dim") or [])]
            x = V[0]
            axes = tuple(a if a >= 0 else a + x.ndim for a in axes) if axes else tuple(range(x.ndim))
            kd = bool(m.get("keepDims", False))
            fn = {"MEAN": np.mean, "SUM": np.sum, "MAXIMUM": np.max, "MINIMUM": np.min, "PROD": np.prod}[opn]
            v = fn(x, axis=axes, keepdims=kd)
            onx = {"MEAN": "ReduceMean", "SUM": "ReduceSum", "MAXIMUM": "ReduceMax", "MINIMUM": "ReduceMin", "PROD": "ReduceProd"}[opn]
            def emit():
                if onx == "ReduceSum":   # opset 13: axes as input
                    self.node(onx, [self.onnx[ii[0]], self._init(np.array(axes, np.int64))], o, keepdims=int(kd))
                else:
                    self.node(onx, [self.onnx[ii[0]]], o, axes=list(axes), keepdims=int(kd))
            keep(np.asarray(v, x.dtype), emit)
        elif t == "Concat":
            ax = int(m.get("axis", 0))
            v = np.concatenate([np.atleast_1d(x) if np.ndim(x) == 0 else x for x in V], axis=ax)
            keep(v, lambda: self.node("Concat", [self.src(i) for i in ii], o, axis=ax))
        elif t == "StridedSlice":
            x = V[0]
            if int(m.get("fromType", 0)) == 1:          # onnx Slice semantics: data, starts, ends, axes, steps
                st, en = np.atleast_1d(V[1]).astype(np.int64), np.atleast_1d(V[2]).astype(np.int64)
                ax = np.atleast_1d(V[3]) if len(V) > 3 else np.arange(len(st))
                sp = np.atleast_1d(V[4]) if len(V) > 4 else np.ones(len(st), np.int64)
                sl = [slice(None)] * x.ndim
                for s_, e_, a_, p_ in zip(st, en, ax, sp):
                    a_ = int(a_) + (x.ndim if a_ < 0 else 0)
                    sl[a_] = slice(int(s_), int(min(e_, 2**62)) if e_ > -2**62 else None, int(p_))
                v = x[tuple(sl)]
                keep(v, lambda: self.node("Slice", [self.onnx[ii[0]], self._init(st.astype(np.int64)), self._init(np.minimum(en, 2**62).astype(np.int64)),
                                                    self._init(ax.astype(np.int64)), self._init(sp.astype(np.int64))], o))
            else:                                        # tf strided slice (masks)
                b, e, s = np.atleast_1d(V[1]), np.atleast_1d(V[2]), np.atleast_1d(V[3])
                bm, em, sm = int(m.get("beginMask", 0)), int(m.get("endMask", 0)), int(m.get("shrinkAxisMask", 0))
                assert int(m.get("ellipsisMask", 0)) == 0 and int(m.get("newAxisMask", 0)) == 0, "ellipsis/newaxis masks"
                sl = []
                for k in range(len(b)):
                    sl.append(int(b[k]) if sm >> k & 1 else slice(None if bm >> k & 1 else int(b[k]), None if em >> k & 1 else int(e[k]), int(s[k])))
                v = x[tuple(sl)]
                def emit():
                    stt, ent, axs, stp = [], [], [], []
                    for k, s_ in enumerate(sl):
                        if isinstance(s_, int):
                            stt.append(s_); ent.append(s_ + 1 if s_ != -1 else 2**62); axs.append(k); stp.append(1)
                        else:
                            stt.append(s_.start if s_.start is not None else (0 if s_.step > 0 else -1))
                            ent.append(s_.stop if s_.stop is not None else (2**62 if s_.step > 0 else -2**62))
                            axs.append(k); stp.append(s_.step)
                    y = self.node("Slice", [self.onnx[ii[0]], self._init(np.array(stt, np.int64)), self._init(np.array(ent, np.int64)),
                                            self._init(np.array(axs, np.int64)), self._init(np.array(stp, np.int64))], o)
                    self.node("Reshape", [y, self._init(np.array(np.shape(v), np.int64))], o)
                keep(v, emit)
        elif t == "SliceTf":
            x, b, sz = V[0], np.atleast_1d(V[1]).astype(int), np.atleast_1d(V[2]).astype(int)
            en = [x.shape[k] if sz[k] < 0 else b[k] + sz[k] for k in range(len(b))]
            v = x[tuple(slice(int(b[k]), int(en[k])) for k in range(len(b)))]
            keep(v, lambda: self.node("Slice", [self.onnx[ii[0]], self._init(b.astype(np.int64)), self._init(np.array(en, np.int64)),
                                                self._init(np.arange(len(b), dtype=np.int64))], o))
        elif t == "BroadcastTo":
            v = np.broadcast_to(V[0], tuple(int(x) for x in np.atleast_1d(V[1]))).copy()
            keep(v, lambda: self.node("Expand", [self.onnx[ii[0]], self._init(np.array(v.shape, np.int64))], o))
        elif t == "GatherV2":
            ax = int(np.asarray(V[2]).item()) if len(V) > 2 else 0
            v = np.take(V[0], np.asarray(V[1]).astype(np.int64), axis=ax)
            keep(v, lambda: self.node("Gather", [self.src(ii[0]), self.src(ii[1], as_int=True)], o, axis=ax))
        elif t == "Cast":
            dst = NP_DT.get(m.get("dstT"), np.float32)
            x = V[0]
            v = np.trunc(x).astype(dst) if np.dtype(dst).kind in "iu" and x.dtype.kind == "f" else x.astype(dst)
            to = self.TP.INT64 if np.dtype(dst).kind in "iu" else (self.TP.BOOL if dst == np.bool_ else self.TP.FLOAT)
            keep(v, lambda: self.node("Cast", [self.onnx[ii[0]]], o, to=to))
        elif t in ("TanH", "Sigmoid", "ReLU", "ELU", "ReLU6", "PReLU"):
            x = V[0].astype(np.float32)
            if t == "TanH": v = np.tanh(x)
            elif t == "Sigmoid": v = 1 / (1 + np.exp(-x))
            elif t == "ReLU":
                slope = float(m.get("slope", 0.0)) if isinstance(m, dict) else 0.0
                v = np.where(x > 0, x, x * slope)
            elif t == "ELU":
                al = float(m.get("alpha", 1.0)); v = np.where(x > 0, x, al * (np.exp(x) - 1))
            else:
                lo, hi = float(m.get("minValue", 0.0)), float(m.get("maxValue", 6.0)); v = np.clip(x, lo, hi)
            def emit():
                s = self.onnx[ii[0]]
                if t == "TanH": self.node("Tanh", [s], o)
                elif t == "Sigmoid": self.node("Sigmoid", [s], o)
                elif t == "ReLU":
                    slope = float(m.get("slope", 0.0)) if isinstance(m, dict) else 0.0
                    self.node("LeakyRelu", [s], o, alpha=slope) if slope else self.node("Relu", [s], o)
                elif t == "ELU": self.node("Elu", [s], o, alpha=float(m.get("alpha", 1.0)))
                else: self.node("Clip", [s, self._init(np.float32(max(lo, -3.4e38))), self._init(np.float32(min(hi, 3.4e38)))], o)
            keep(v.astype(np.float32), emit)
        else:
            raise ValueError(f"unsupported MNN op {t}")


def convert(mnn_path, onnx_path, seed=0):
    import onnx
    d = _mnn_to_json(mnn_path)
    inputs = [(op["outputIndexes"][0], op["name"], [int(x) for x in (op["main"].get("dims") or [])])
              for op in d["oplists"] if op["type"] == "Input"]
    feeds = {oi: (nm, sample_input(nm, dims, seed)) for oi, nm, dims in inputs}
    c = Converter(d, mnn_path)
    c.run(feeds)
    outs, graph_outs = [], []
    for nm in d.get("outputName", []):
        idx = c.names.index(nm)
        v = c.val[idx]
        src = c.src(idx)
        c.nodes.append(c.h.make_node("Identity", [src], [nm]))
        graph_outs.append(c.h.make_tensor_value_info(nm, c.TP.FLOAT, list(np.shape(v))))
        outs.append((nm, v))
    graph_ins = [c.h.make_tensor_value_info(nm, c.TP.FLOAT, dims) for _, nm, dims in inputs]
    model = c.h.make_model(c.h.make_graph(c.nodes, os.path.basename(mnn_path), graph_ins, graph_outs, c.inits),
                           opset_imports=[c.h.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, onnx_path)
    return {nm: dims for _, nm, dims in inputs}, [nm for nm, _ in outs]


def sample_input(name, dims, seed):
    rng = np.random.default_rng(seed + (hash(name) % 1000))
    if "time" in name.lower():                   # time index into an embedded motion table
        return rng.integers(0, 50, size=dims).astype(np.float32)
    return (rng.standard_normal(dims) * 0.5).astype(np.float32)


def verify(mnn_path, onnx_path, in_dims, out_names, trials=3):
    """max |onnx - MNN| over random inputs (MNN run through its own Interpreter session API)."""
    import MNN, onnxruntime as ort
    so = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    it = MNN.Interpreter(mnn_path); s = it.createSession()
    err = 0.0
    for k in range(trials):
        feeds = {nm: sample_input(nm, dims, 100 + k) for nm, dims in in_dims.items()}
        for nm, v in feeds.items():
            t = it.getSessionInput(s, nm)
            t.copyFrom(MNN.Tensor(list(v.shape), MNN.Halide_Type_Float, v, MNN.Tensor_DimensionType_Caffe))
        it.runSession(s)
        ref = {nm: np.array(it.getSessionOutput(s, nm).getData()).reshape(-1) for nm in out_names}
        got = dict(zip([o.name for o in so.get_outputs()], so.run(None, feeds)))
        for nm in out_names:
            err = max(err, float(np.abs(got[nm].reshape(-1) - ref[nm]).max()))
    return err


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mnn", nargs="*")
    ap.add_argument("--out", help="output .onnx (single input only)")
    a = ap.parse_args()
    bad = 0
    for f in a.mnn:
        out = a.out if (a.out and len(a.mnn) == 1) else f[:-4] + ".onnx"
        try:
            ins, outs = convert(f, out)
            e = verify(f, out, ins, outs)
            tag = "OK      " if e < 1e-3 else "MISMATCH"
            bad += e >= 1e-3
            print(f"  {tag} {f}  max|d|={e:.2e}  in={ins} out={outs}", flush=True)
        except Exception as ex:
            bad += 1
            print(f"  FAIL     {f}  {type(ex).__name__}: {ex}", flush=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
