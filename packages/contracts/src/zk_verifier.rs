use soroban_sdk::{BytesN, Vec as SorobanVec};

// ─────────────────────────────────────────────────────────────────────────────
// BN254 Field and Curve Constants
// ─────────────────────────────────────────────────────────────────────────────

pub const P: [u64; 4] = [
    0x3c208c16d87cfd47,
    0x97816a916871ca8d,
    0xb85045b68181585d,
    0x30644e72e131a029,
];

pub const P_PRIME: u64 = 0x87d20782e4866389;

pub const R_MOD_P: Fp = Fp([
    0xd35d438dc58f0d9d,
    0x0a78eb28f5c70b3d,
    0x666ea36f7879462c,
    0x0e0a77c19a07df2f,
]);

pub const R2_MOD_P: Fp = Fp([
    0xf32cfc5b538afa89,
    0xb5e71911d44501fb,
    0x47ab1eff0a417ff6,
    0x06d89f71cab8351f,
]);

pub const P_MINUS_2: [u64; 4] = [
    0x3c208c16d87cfd45,
    0x97816a916871ca8d,
    0xb85045b68181585d,
    0x30644e72e131a029,
];

pub const R_SCALAR: [u64; 4] = [
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
];

pub const B_G2: Fp2 = Fp2(
    Fp([0x3bf938e377b802a8, 0x020b1b273633535d, 0x26b7edf049755260, 0x2514c6324384a86d]),
    Fp([0x38e7ecccd1dcff67, 0x65f0b37d93ce0d3e, 0xd749d0dd22ac00aa, 0x0141b9ce4a688d4d]),
);

pub const G2_G2: Fp2 = Fp2(
    Fp([0xb5773b104563ab30, 0x347f91c8a9aa6454, 0x7a007127242e0991, 0x1956bcd8118214ec]),
    Fp([0x6e849f1ea0aa4757, 0xaa1c7b6d89f89141, 0xb6e713cdfae0ca3a, 0x26694fbb4e82ebc3]),
);

pub const G2_G3: Fp2 = Fp2(
    Fp([0xe4bbdd0c2936b629, 0xbb30f162e133bacb, 0x31a9d1b6f9645366, 0x253570bea500f8dd]),
    Fp([0xa1d77ce45ffe77c7, 0x07affd117826d1db, 0x6d16bd27bb7edc6b, 0x2c87200285defecc]),
);

pub const G2_H2: Fp2 = Fp2(
    Fp([0x3350c88e13e80b9c, 0x7dce557cdb5e56b9, 0x6001b4b8b615564a, 0x2682e617020217e0]),
    Fp([0, 0, 0, 0]),
);

pub const H1: Fp = Fp([0xca8d800500fa1bf2, 0xf0c5d61468b39769, 0x0e201271ad0d4418, 0x04290f65bad856e6]);
pub const H2: Fp = Fp([0x3350c88e13e80b9c, 0x7dce557cdb5e56b9, 0x6001b4b8b615564a, 0x2682e617020217e0]);

pub const D_EXPONENT: [u64; 12] = [
    0xe81bb482ccdf42b1,
    0x5abf5cc4f49c36d4,
    0xf1154e7e1da014fd,
    0xdcc7b44c87cdbacf,
    0xaaa441e3954bcf8a,
    0x6b887d56d5095f23,
    0x79581e16f3fd90c6,
    0x3b1b1355d189227d,
    0x4e529a5861876f6b,
    0x6c0eb522d5b12278,
    0x331ec15183177faf,
    0x01baaa710b0759ad,
];

// ─────────────────────────────────────────────────────────────────────────────
// Finite Field Representations
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Fp(pub [u64; 4]);

impl Fp {
    pub const ZERO: Self = Fp([0; 4]);
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Fp2(pub Fp, pub Fp);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Fp6(pub Fp2, pub Fp2, pub Fp2);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Fp12(pub Fp6, pub Fp6);

// ─────────────────────────────────────────────────────────────────────────────
// Fp Arithmetic
// ─────────────────────────────────────────────────────────────────────────────


pub fn lt(a: [u64; 4], b: [u64; 4]) -> bool {
    for i in (0..4).rev() {
        if a[i] < b[i] {
            return true;
        } else if a[i] > b[i] {
            return false;
        }
    }
    false
}


pub fn mont_add(a: Fp, b: Fp) -> Fp {
    let mut res = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        let (val, c) = a.0[i].overflowing_add(b.0[i]);
        let (val2, c2) = val.overflowing_add(carry);
        res[i] = val2;
        carry = (c as u64) + (c2 as u64);
    }
    if carry > 0 || !lt(res, P) {
        let mut borrow = 0u64;
        for i in 0..4 {
            let (val, b_out) = res[i].overflowing_sub(P[i]);
            let (val2, b_out2) = val.overflowing_sub(borrow);
            res[i] = val2;
            borrow = (b_out as u64) + (b_out2 as u64);
        }
    }
    Fp(res)
}


pub fn mont_sub(a: Fp, b: Fp) -> Fp {
    let mut res = [0u64; 4];
    let mut borrow = 0u64;
    for i in 0..4 {
        let (val, b_out) = a.0[i].overflowing_sub(b.0[i]);
        let (val2, b_out2) = val.overflowing_sub(borrow);
        res[i] = val2;
        borrow = (b_out as u64) + (b_out2 as u64);
    }
    if borrow > 0 {
        let mut carry = 0u64;
        for i in 0..4 {
            let (val, c_out) = res[i].overflowing_add(P[i]);
            let (val2, c_out2) = val.overflowing_add(carry);
            res[i] = val2;
            carry = (c_out as u64) + (c_out2 as u64);
        }
    }
    Fp(res)
}


pub fn mont_mul(a: Fp, b: Fp) -> Fp {
    let mut t = [0u64; 8];
    for i in 0..4 {
        let mut carry = 0u64;
        for j in 0..4 {
            let prod = (a.0[i] as u128) * (b.0[j] as u128) + (t[i + j] as u128) + (carry as u128);
            t[i + j] = prod as u64;
            carry = (prod >> 64) as u64;
        }
        t[i + 4] = carry;
    }

    for i in 0..4 {
        let m = t[i].wrapping_mul(P_PRIME);
        let mut carry = 0u64;
        for j in 0..4 {
            let prod = (m as u128) * (P[j] as u128) + (t[i + j] as u128) + (carry as u128);
            t[i + j] = prod as u64;
            carry = (prod >> 64) as u64;
        }
        let mut k = i + 4;
        while carry > 0 && k < 8 {
            let sum = (t[k] as u128) + (carry as u128);
            t[k] = sum as u64;
            carry = (sum >> 64) as u64;
            k += 1;
        }
    }

    let mut res = [t[4], t[5], t[6], t[7]];
    if !lt(res, P) {
        let mut borrow = 0u64;
        for i in 0..4 {
            let (val, b_out) = res[i].overflowing_sub(P[i]);
            let (val2, b_out2) = val.overflowing_sub(borrow);
            res[i] = val2;
            borrow = (b_out as u64) + (b_out2 as u64);
        }
    }
    Fp(res)
}


pub fn mont_pow(a: Fp, exp: [u64; 4]) -> Fp {
    let mut res = R_MOD_P;
    let mut base = a;
    for i in 0..4 {
        let mut e = exp[i];
        for _ in 0..64 {
            if (e & 1) == 1 {
                res = mont_mul(res, base);
            }
            base = mont_mul(base, base);
            e >>= 1;
        }
    }
    res
}


pub fn fp_invert(a: Fp) -> Option<Fp> {
    if a == Fp::ZERO {
        None
    } else {
        Some(mont_pow(a, P_MINUS_2))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fp2 Arithmetic
// ─────────────────────────────────────────────────────────────────────────────

pub const FP2_ZERO: Fp2 = Fp2(Fp::ZERO, Fp::ZERO);


pub fn fp2_add(a: Fp2, b: Fp2) -> Fp2 {
    Fp2(mont_add(a.0, b.0), mont_add(a.1, b.1))
}


pub fn fp2_sub(a: Fp2, b: Fp2) -> Fp2 {
    Fp2(mont_sub(a.0, b.0), mont_sub(a.1, b.1))
}


pub fn fp2_conjugate(a: Fp2) -> Fp2 {
    Fp2(a.0, mont_sub(Fp::ZERO, a.1))
}


pub fn fp2_mul(a: Fp2, b: Fp2) -> Fp2 {
    let v0 = mont_mul(a.0, b.0);
    let v1 = mont_mul(a.1, b.1);
    let real = mont_sub(v0, v1);
    let imag = mont_sub(
        mont_mul(mont_add(a.0, a.1), mont_add(b.0, b.1)),
        mont_add(v0, v1),
    );
    Fp2(real, imag)
}


pub fn fp2_square(a: Fp2) -> Fp2 {
    let real = mont_mul(mont_sub(a.0, a.1), mont_add(a.0, a.1));
    let imag = mont_mul(mont_add(a.0, a.0), a.1);
    Fp2(real, imag)
}


pub fn fp2_invert(a: Fp2) -> Option<Fp2> {
    let t = mont_add(mont_mul(a.0, a.0), mont_mul(a.1, a.1));
    let t_inv = fp_invert(t)?;
    Some(Fp2(mont_mul(a.0, t_inv), mont_sub(Fp::ZERO, mont_mul(a.1, t_inv))))
}


pub fn fp2_mul_scalar(x: Fp2, s: Fp) -> Fp2 {
    Fp2(mont_mul(x.0, s), mont_mul(x.1, s))
}


pub fn fp2_mul_xi(x: Fp2) -> Fp2 {
    let nine = Fp([9, 0, 0, 0]);
    let nine_mont = mont_mul(nine, R2_MOD_P);
    let nine_x0 = mont_mul(x.0, nine_mont);
    let nine_x1 = mont_mul(x.1, nine_mont);
    Fp2(mont_sub(nine_x0, x.1), mont_add(nine_x1, x.0))
}

// ─────────────────────────────────────────────────────────────────────────────
// Fp6 Arithmetic
// ─────────────────────────────────────────────────────────────────────────────

pub const FP6_ZERO: Fp6 = Fp6(FP2_ZERO, FP2_ZERO, FP2_ZERO);


pub fn fp6_add(a: Fp6, b: Fp6) -> Fp6 {
    Fp6(fp2_add(a.0, b.0), fp2_add(a.1, b.1), fp2_add(a.2, b.2))
}


pub fn fp6_sub(a: Fp6, b: Fp6) -> Fp6 {
    Fp6(fp2_sub(a.0, b.0), fp2_sub(a.1, b.1), fp2_sub(a.2, b.2))
}


pub fn fp6_mul(x: Fp6, y: Fp6) -> Fp6 {
    let v0 = fp2_mul(x.0, y.0);
    let v1 = fp2_mul(x.1, y.1);
    let v2 = fp2_mul(x.2, y.2);

    let c0 = fp2_add(
        fp2_mul_xi(fp2_sub(
            fp2_sub(fp2_mul(fp2_add(x.1, x.2), fp2_add(y.1, y.2)), v1),
            v2,
        )),
        v0,
    );
    let c1 = fp2_add(
        fp2_mul_xi(v2),
        fp2_sub(
            fp2_sub(fp2_mul(fp2_add(x.0, x.1), fp2_add(y.0, y.1)), v0),
            v1,
        ),
    );
    let c2 = fp2_add(
        v1,
        fp2_sub(
            fp2_sub(fp2_mul(fp2_add(x.0, x.2), fp2_add(y.0, y.2)), v0),
            v2,
        ),
    );

    Fp6(c0, c1, c2)
}


pub fn fp6_square(x: Fp6) -> Fp6 {
    let ab2 = fp2_add(fp2_mul(x.0, x.1), fp2_mul(x.0, x.1));
    let bc2 = fp2_add(fp2_mul(x.1, x.2), fp2_mul(x.1, x.2));
    let ac2 = fp2_add(fp2_mul(x.0, x.2), fp2_mul(x.0, x.2));

    let c0 = fp2_add(fp2_square(x.0), fp2_mul_xi(bc2));
    let c1 = fp2_add(ab2, fp2_mul_xi(fp2_square(x.2)));
    let c2 = fp2_add(fp2_square(x.1), ac2);
    Fp6(c0, c1, c2)
}


pub fn fp6_invert(x: Fp6) -> Option<Fp6> {
    let a = x.0;
    let b = x.1;
    let c = x.2;

    let bc = fp2_mul(b, c);
    let bc_xi = fp2_mul_xi(bc);
    let a_sq = fp2_square(a);
    let A = fp2_sub(a_sq, bc_xi);

    let ab = fp2_mul(a, b);
    let c_sq = fp2_square(c);
    let c_sq_xi = fp2_mul_xi(c_sq);
    let B = fp2_sub(c_sq_xi, ab);

    let ac = fp2_mul(a, c);
    let b_sq = fp2_square(b);
    let C = fp2_sub(b_sq, ac);

    let aA = fp2_mul(a, A);
    let cB = fp2_mul(c, B);
    let cB_xi = fp2_mul_xi(cB);
    let bC = fp2_mul(b, C);
    let bC_xi = fp2_mul_xi(bC);

    let D = fp2_add(aA, fp2_add(cB_xi, bC_xi));

    let D_inv = fp2_invert(D)?;

    Some(Fp6(
        fp2_mul(A, D_inv),
        fp2_mul(B, D_inv),
        fp2_mul(C, D_inv),
    ))
}


pub fn fp6_mul_v(x: Fp6) -> Fp6 {
    Fp6(fp2_mul_xi(x.2), x.0, x.1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Fp12 Arithmetic
// ─────────────────────────────────────────────────────────────────────────────

impl Fp12 {
    pub const ONE: Fp12 = Fp12(Fp6(Fp2(R_MOD_P, Fp::ZERO), FP2_ZERO, FP2_ZERO), FP6_ZERO);
}


pub fn fp12_add(a: Fp12, b: Fp12) -> Fp12 {
    Fp12(fp6_add(a.0, b.0), fp6_add(a.1, b.1))
}


pub fn fp12_sub(a: Fp12, b: Fp12) -> Fp12 {
    Fp12(fp6_sub(a.0, b.0), fp6_sub(a.1, b.1))
}


pub fn fp12_conjugate(a: Fp12) -> Fp12 {
    Fp12(a.0, fp6_sub(FP6_ZERO, a.1))
}


pub fn fp12_mul(x: Fp12, y: Fp12) -> Fp12 {
    let v0 = fp6_mul(x.0, y.0);
    let v1 = fp6_mul(x.1, y.1);

    let c0 = fp6_add(v0, fp6_mul_v(v1));
    let c1 = fp6_sub(
        fp6_sub(fp6_mul(fp6_add(x.0, x.1), fp6_add(y.0, y.1)), v0),
        v1,
    );

    Fp12(c0, c1)
}


pub fn fp12_square(x: Fp12) -> Fp12 {
    let a = x.0;
    let b = x.1;
    let ab2 = fp6_add(fp6_mul(a, b), fp6_mul(a, b));
    let a_sq = fp6_square(a);
    let b_sq = fp6_square(b);
    Fp12(fp6_add(a_sq, fp6_mul_v(b_sq)), ab2)
}


pub fn fp12_invert(x: Fp12) -> Option<Fp12> {
    let a = x.0;
    let b = x.1;
    let t = fp6_sub(fp6_square(a), fp6_mul_v(fp6_square(b)));
    let t_inv = fp6_invert(t)?;
    Some(Fp12(fp6_mul(a, t_inv), fp6_sub(FP6_ZERO, fp6_mul(b, t_inv))))
}


pub fn fp12_frobenius_map2(x: Fp12) -> Fp12 {
    let a = x.0;
    let b = x.1;

    let neg_h1 = mont_sub(Fp::ZERO, H1);
    let neg_h2 = mont_sub(Fp::ZERO, H2);

    let a0 = a.0;
    let a1 = fp2_mul_scalar(a.1, H2);
    let a2 = fp2_mul_scalar(a.2, neg_h1);

    let b0 = fp2_mul_scalar(b.0, H1);
    let b1 = fp2_sub(FP2_ZERO, b.1);
    let b2 = fp2_mul_scalar(b.2, neg_h2);

    Fp12(Fp6(a0, a1, a2), Fp6(b0, b1, b2))
}


pub fn fp12_pow(a: Fp12, exp: [u64; 12]) -> Fp12 {
    let mut res = Fp12::ONE;
    let mut base = a;
    for i in 0..12 {
        let mut e = exp[i];
        for _ in 0..64 {
            if (e & 1) == 1 {
                res = fp12_mul(res, base);
            }
            base = fp12_square(base);
            e >>= 1;
        }
    }
    res
}

// ─────────────────────────────────────────────────────────────────────────────
// Elliptic Curve Groups G1 and G2
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum G1Point {
    Infinity,
    Affine(Fp, Fp),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum G2Point {
    Infinity,
    Affine(Fp2, Fp2),
}

impl G1Point {
    pub fn is_on_curve(&self) -> bool {
        match self {
            G1Point::Infinity => true,
            G1Point::Affine(x, y) => {
                let y_sq = mont_mul(*y, *y);
                let x_sq = mont_mul(*x, *x);
                let x_cube = mont_mul(x_sq, *x);
                let three_mont = mont_mul(Fp([3, 0, 0, 0]), R2_MOD_P);
                let rhs = mont_add(x_cube, three_mont);
                y_sq == rhs
            }
        }
    }
}

impl G2Point {
    pub fn is_on_curve(&self) -> bool {
        match self {
            G2Point::Infinity => true,
            G2Point::Affine(x, y) => {
                let y_sq = fp2_square(*y);
                let x_sq = fp2_square(*x);
                let x_cube = fp2_mul(x_sq, *x);
                let rhs = fp2_add(x_cube, B_G2);
                y_sq == rhs
            }
        }
    }
}

pub fn g1_double(x: Fp, y: Fp) -> Option<(Fp, Fp)> {
    if y == Fp::ZERO {
        return None;
    }
    let x_sq = mont_mul(x, x);
    let num = mont_add(x_sq, mont_add(x_sq, x_sq));
    let denom = mont_add(y, y);
    let denom_inv = fp_invert(denom)?;
    let lambda = mont_mul(num, denom_inv);

    let lambda_sq = mont_mul(lambda, lambda);
    let x3 = mont_sub(mont_sub(lambda_sq, x), x);
    let y3 = mont_sub(mont_mul(lambda, mont_sub(x, x3)), y);
    Some((x3, y3))
}

pub fn g1_add(x1: Fp, y1: Fp, x2: Fp, y2: Fp) -> Option<(Fp, Fp)> {
    if x1 == x2 {
        if y1 == y2 {
            return g1_double(x1, y1);
        } else {
            return None;
        }
    }
    let num = mont_sub(y2, y1);
    let denom = mont_sub(x2, x1);
    let denom_inv = fp_invert(denom)?;
    let lambda = mont_mul(num, denom_inv);

    let lambda_sq = mont_mul(lambda, lambda);
    let x3 = mont_sub(mont_sub(lambda_sq, x1), x2);
    let y3 = mont_sub(mont_mul(lambda, mont_sub(x1, x3)), y1);
    Some((x3, y3))
}

pub fn g1_add_points(a: G1Point, b: G1Point) -> G1Point {
    match (a, b) {
        (G1Point::Infinity, _) => b,
        (_, G1Point::Infinity) => a,
        (G1Point::Affine(ax, ay), G1Point::Affine(bx, by)) => {
            match g1_add(ax, ay, bx, by) {
                Some((nx, ny)) => G1Point::Affine(nx, ny),
                None => G1Point::Infinity,
            }
        }
    }
}

pub fn g1_mul(p: G1Point, scalar: [u64; 4]) -> Option<G1Point> {
    let mut res = G1Point::Infinity;
    let mut temp = p;
    for i in 0..4 {
        let mut s = scalar[i];
        for _ in 0..64 {
            if (s & 1) == 1 {
                res = g1_add_points(res, temp);
            }
            temp = match temp {
                G1Point::Infinity => G1Point::Infinity,
                G1Point::Affine(tx, ty) => match g1_double(tx, ty) {
                    Some((nx, ny)) => G1Point::Affine(nx, ny),
                    None => G1Point::Infinity,
                },
            };
            s >>= 1;
        }
    }
    Some(res)
}

pub fn g2_double(x: Fp2, y: Fp2) -> Option<(Fp2, Fp2, Fp2)> {
    if y == FP2_ZERO {
        return None;
    }
    let x_sq = fp2_square(x);
    let num = fp2_add(x_sq, fp2_add(x_sq, x_sq));
    let denom = fp2_add(y, y);
    let denom_inv = fp2_invert(denom)?;
    let lambda = fp2_mul(num, denom_inv);

    let lambda_sq = fp2_square(lambda);
    let x3 = fp2_sub(fp2_sub(lambda_sq, x), x);
    let y3 = fp2_sub(fp2_mul(lambda, fp2_sub(x, x3)), y);
    Some((x3, y3, lambda))
}

pub fn g2_add(x1: Fp2, y1: Fp2, x2: Fp2, y2: Fp2) -> Option<(Fp2, Fp2, Fp2)> {
    if x1 == x2 {
        if y1 == y2 {
            return g2_double(x1, y1);
        } else {
            return None;
        }
    }
    let num = fp2_sub(y2, y1);
    let denom = fp2_sub(x2, x1);
    let denom_inv = fp2_invert(denom)?;
    let lambda = fp2_mul(num, denom_inv);

    let lambda_sq = fp2_square(lambda);
    let x3 = fp2_sub(fp2_sub(lambda_sq, x1), x2);
    let y3 = fp2_sub(fp2_mul(lambda, fp2_sub(x1, x3)), y1);
    Some((x3, y3, lambda))
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing Engine (Optimal Ate Pairing on Affine Coordinates)
// ─────────────────────────────────────────────────────────────────────────────

pub fn eval_line(lambda: Fp2, x1: Fp2, y1: Fp2, px: Fp, py: Fp) -> Fp12 {
    let px_fp2 = Fp2(px, Fp::ZERO);
    let py_fp2 = Fp2(py, Fp::ZERO);
    let b0 = fp2_sub(FP2_ZERO, fp2_mul(lambda, px_fp2));
    let a0 = fp2_sub(fp2_mul(lambda, x1), y1);

    Fp12(
        Fp6(py_fp2, FP2_ZERO, FP2_ZERO),
        Fp6(b0, a0, FP2_ZERO),
    )
}

pub fn multi_pairing(pairs: &[(G1Point, G2Point)]) -> Option<Fp12> {
    let mut f = Fp12::ONE;

    let mut T = [(FP2_ZERO, FP2_ZERO); 4];
    let mut P_coords = [(Fp::ZERO, Fp::ZERO); 4];
    let mut Q = [(FP2_ZERO, FP2_ZERO); 4];

    let n = pairs.len();
    if n > 4 {
        return None;
    }

    for j in 0..n {
        match (pairs[j].0, pairs[j].1) {
            (G1Point::Affine(px, py), G2Point::Affine(qx, qy)) => {
                T[j] = (qx, qy);
                P_coords[j] = (px, py);
                Q[j] = (qx, qy);
            }
            _ => return None,
        }
    }

    const BITS: &[u8] = &[
        1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1,
        0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1,
        0, 1, 0, 0, 0,
    ];

    for i in 1..BITS.len() {
        f = fp12_square(f);

        for j in 0..n {
            let (tx, ty) = T[j];
            let (px, py) = P_coords[j];
            let (nx, ny, lambda) = g2_double(tx, ty)?;
            T[j] = (nx, ny);
            let l = eval_line(lambda, tx, ty, px, py);
            f = fp12_mul(f, l);
        }

        if BITS[i] == 1 {
            for j in 0..n {
                let (tx, ty) = T[j];
                let (qx, qy) = Q[j];
                let (px, py) = P_coords[j];
                let (nx, ny, lambda) = g2_add(tx, ty, qx, qy)?;
                T[j] = (nx, ny);
                let l = eval_line(lambda, tx, ty, px, py);
                f = fp12_mul(f, l);
            }
        }
    }



    for j in 0..n {
        let (qx, qy) = Q[j];
        let (px, py) = P_coords[j];
        let (tx, ty) = T[j];

        let qx_pi = fp2_mul(fp2_conjugate(qx), G2_G2);
        let qy_pi = fp2_mul(fp2_conjugate(qy), G2_G3);

        let (nx, ny, lambda) = g2_add(tx, ty, qx_pi, qy_pi)?;
        let l1 = eval_line(lambda, tx, ty, px, py);
        f = fp12_mul(f, l1);

        let qx_pi2 = fp2_mul(qx, G2_H2);
        let qy_pi2 = qy;

        let (_, _, lambda2) = g2_add(nx, ny, qx_pi2, qy_pi2)?;
        let l2 = eval_line(lambda2, nx, ny, px, py);
        f = fp12_mul(f, l2);
    }
    #[cfg(test)]
    {
        extern crate std;
        std::println!("Rust f after main loop: {}", fp12_to_hex(f));
    }
    // Final Exponentiation
    // Easy part
    let f1 = fp12_conjugate(f);
    let f_inv = fp12_invert(f)?;
    let mut easy = fp12_mul(f1, f_inv); // f^(p^6 - 1)

    let easy_pi2 = fp12_frobenius_map2(easy);
    easy = fp12_mul(easy_pi2, easy); // f^((p^6 - 1)(p^2 + 1))

    // Hard part
    let hard = fp12_pow(easy, D_EXPONENT);

    Some(hard)
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload Parsers & High-Level Verifier
// ─────────────────────────────────────────────────────────────────────────────

pub fn parse_fp(bytes: &[u8; 32]) -> Option<Fp> {
    let mut limbs = [0u64; 4];
    for i in 0..4 {
        let offset = (3 - i) * 8;
        limbs[i] = u64::from_be_bytes(bytes[offset..offset + 8].try_into().unwrap());
    }
    if !lt(limbs, P) {
        return None;
    }
    Some(mont_mul(Fp(limbs), R2_MOD_P))
}

pub fn parse_fp2(bytes: &[u8; 64]) -> Option<Fp2> {
    let mut real_bytes = [0u8; 32];
    let mut imag_bytes = [0u8; 32];
    real_bytes.copy_from_slice(&bytes[0..32]);
    imag_bytes.copy_from_slice(&bytes[32..64]);
    let real = parse_fp(&real_bytes)?;
    let imag = parse_fp(&imag_bytes)?;
    Some(Fp2(real, imag))
}

pub fn parse_g1(bytes: &[u8; 64]) -> Option<G1Point> {
    let mut is_zero = true;
    for b in bytes {
        if *b != 0 {
            is_zero = false;
            break;
        }
    }
    if is_zero {
        return Some(G1Point::Infinity);
    }

    let mut x_bytes = [0u8; 32];
    let mut y_bytes = [0u8; 32];
    x_bytes.copy_from_slice(&bytes[0..32]);
    y_bytes.copy_from_slice(&bytes[32..64]);

    let x = parse_fp(&x_bytes)?;
    let y = parse_fp(&y_bytes)?;

    let p = G1Point::Affine(x, y);
    if !p.is_on_curve() {
        return None;
    }
    Some(p)
}

pub fn parse_g2(bytes: &[u8; 128]) -> Option<G2Point> {
    let mut is_zero = true;
    for b in bytes {
        if *b != 0 {
            is_zero = false;
            break;
        }
    }
    if is_zero {
        return Some(G2Point::Infinity);
    }

    let mut x_bytes = [0u8; 64];
    let mut y_bytes = [0u8; 64];
    x_bytes.copy_from_slice(&bytes[0..64]);
    y_bytes.copy_from_slice(&bytes[64..128]);

    let x = parse_fp2(&x_bytes)?;
    let y = parse_fp2(&y_bytes)?;

    let p = G2Point::Affine(x, y);
    if !p.is_on_curve() {
        return None;
    }
    Some(p)
}

pub fn parse_scalar(bytes: &[u8; 32]) -> Option<[u64; 4]> {
    let mut limbs = [0u64; 4];
    for i in 0..4 {
        let offset = (3 - i) * 8;
        limbs[i] = u64::from_be_bytes(bytes[offset..offset + 8].try_into().unwrap());
    }
    if !lt(limbs, R_SCALAR) {
        return None;
    }
    Some(limbs)
}
#[cfg(test)]
extern crate std;

#[cfg(test)]
pub fn fp_to_hex(val: Fp) -> std::string::String {
    let std_val = mont_mul(val, Fp([1, 0, 0, 0]));
    std::format!("{:016x}{:016x}{:016x}{:016x}", std_val.0[3], std_val.0[2], std_val.0[1], std_val.0[0])
}
#[cfg(test)]
pub fn fp2_to_hex(val: Fp2) -> std::string::String {
    std::format!("Fp2({}, {})", fp_to_hex(val.0), fp_to_hex(val.1))
}
#[cfg(test)]
pub fn fp6_to_hex(val: Fp6) -> std::string::String {
    std::format!("Fp6({}, {}, {})", fp2_to_hex(val.0), fp2_to_hex(val.1), fp2_to_hex(val.2))
}
#[cfg(test)]
pub fn fp12_to_hex(val: Fp12) -> std::string::String {
    std::format!("Fp12({}, {})", fp6_to_hex(val.0), fp6_to_hex(val.1))
}


/// Verifies a Groth16 zk-SNARK proof over BN254.
/// 
/// The verification equation is:
/// e(A, B) * e(L, -gamma) * e(C, -delta) * e(alpha, -beta) == 1
/// where L = IC_0 + \sum_{i=1}^l x_i * IC_i
pub fn verify_groth16(
    proof_a: &BytesN<64>,
    proof_b: &BytesN<128>,
    proof_c: &BytesN<64>,
    public_inputs: &SorobanVec<BytesN<32>>,
    vk_alpha: &BytesN<64>,
    vk_beta: &BytesN<128>,
    vk_gamma: &BytesN<128>,
    vk_delta: &BytesN<128>,
    vk_ic: &SorobanVec<BytesN<64>>,
) -> bool {
    let p_a = match parse_g1(&proof_a.to_array()) {
        Some(pt) => pt,
        None => return false,
    };
    let p_b = match parse_g2(&proof_b.to_array()) {
        Some(pt) => pt,
        None => return false,
    };
    let p_c = match parse_g1(&proof_c.to_array()) {
        Some(pt) => pt,
        None => return false,
    };

    let alpha = match parse_g1(&vk_alpha.to_array()) {
        Some(pt) => pt,
        None => return false,
    };
    let beta = match parse_g2(&vk_beta.to_array()) {
        Some(pt) => pt,
        None => return false,
    };
    let gamma = match parse_g2(&vk_gamma.to_array()) {
        Some(pt) => pt,
        None => return false,
    };
    let delta = match parse_g2(&vk_delta.to_array()) {
        Some(pt) => pt,
        None => return false,
    };

    if vk_ic.len() != public_inputs.len() + 1 {
        return false;
    }

    let mut l = match parse_g1(&vk_ic.get(0).unwrap().to_array()) {
        Some(pt) => pt,
        None => return false,
    };

    for i in 0..public_inputs.len() {
        let input_bytes = public_inputs.get(i).unwrap().to_array();
        let scalar = match parse_scalar(&input_bytes) {
            Some(s) => s,
            None => return false,
        };
        let ic_pt = match parse_g1(&vk_ic.get(i + 1).unwrap().to_array()) {
            Some(pt) => pt,
            None => return false,
        };
        let term = match g1_mul(ic_pt, scalar) {
            Some(pt) => pt,
            None => return false,
        };
        l = g1_add_points(l, term);
    }

    // Negate the G2 points for the pairing check equation:
    // e(A, B) * e(L, -gamma) * e(C, -delta) * e(alpha, -beta) == 1
    let neg_gamma = match gamma {
        G2Point::Infinity => G2Point::Infinity,
        G2Point::Affine(gx, gy) => G2Point::Affine(gx, fp2_sub(FP2_ZERO, gy)),
    };
    let neg_delta = match delta {
        G2Point::Infinity => G2Point::Infinity,
        G2Point::Affine(dx, dy) => G2Point::Affine(dx, fp2_sub(FP2_ZERO, dy)),
    };
    let neg_beta = match beta {
        G2Point::Infinity => G2Point::Infinity,
        G2Point::Affine(bx, by) => G2Point::Affine(bx, fp2_sub(FP2_ZERO, by)),
    };

    let pairs = [
        (p_a, p_b),
        (l, neg_gamma),
        (p_c, neg_delta),
        (alpha, neg_beta),
    ];

    #[cfg(test)]
    {
        let e_ab = multi_pairing(&[(p_a, p_b)]).unwrap_or(Fp12::ONE);
        let e_l_gamma = multi_pairing(&[(l, gamma)]).unwrap_or(Fp12::ONE);
        let e_c_delta = multi_pairing(&[(p_c, delta)]).unwrap_or(Fp12::ONE);
        let e_alpha_beta = multi_pairing(&[(alpha, beta)]).unwrap_or(Fp12::ONE);
        let rhs = fp12_mul(e_l_gamma, fp12_mul(e_c_delta, e_alpha_beta));

        extern crate std;
        std::println!("e_ab: {}", fp12_to_hex(e_ab));
        std::println!("rhs: {}", fp12_to_hex(rhs));
        std::println!("e_ab == rhs: {}", e_ab == rhs);
    }

    match multi_pairing(&pairs) {
        Some(res) => {
            #[cfg(test)]
            {
                extern crate std;
                std::println!("res: {}", fp12_to_hex(res));
                std::println!("res == ONE: {}", res == Fp12::ONE);
            }
            res == Fp12::ONE
        }
        None => {
            #[cfg(test)]
            {
                extern crate std;
                std::println!("multi_pairing returned None!");
            }
            false
        }
    }
}
