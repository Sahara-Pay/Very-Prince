

#[derive(Debug, PartialEq, Eq)]
pub enum XdrError {
    UnexpectedEndOfStream,
    InvalidPadding,
    MalformedData,
}

pub struct Cursor<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    pub fn position(&self) -> usize {
        self.position
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.position)
    }

    pub fn advance(&mut self, amount: usize) -> Result<(), XdrError> {
        if self.remaining() < amount {
            return Err(XdrError::UnexpectedEndOfStream);
        }
        self.position += amount;
        Ok(())
    }

    pub fn read_u32(&mut self) -> Result<u32, XdrError> {
        if self.remaining() < 4 {
            return Err(XdrError::UnexpectedEndOfStream);
        }
        let bytes = &self.data[self.position..self.position + 4];
        let val = u32::from_be_bytes(bytes.try_into().unwrap());
        self.position += 4;
        Ok(val)
    }

    pub fn read_i32(&mut self) -> Result<i32, XdrError> {
        self.read_u32().map(|v| v as i32)
    }

    pub fn read_bool(&mut self) -> Result<bool, XdrError> {
        match self.read_u32()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(XdrError::MalformedData),
        }
    }

    pub fn read_u64(&mut self) -> Result<u64, XdrError> {
        if self.remaining() < 8 {
            return Err(XdrError::UnexpectedEndOfStream);
        }
        let bytes = &self.data[self.position..self.position + 8];
        let val = u64::from_be_bytes(bytes.try_into().unwrap());
        self.position += 8;
        Ok(val)
    }

    pub fn read_opaque(&mut self, len: usize) -> Result<&'a [u8], XdrError> {
        if self.remaining() < len {
            return Err(XdrError::UnexpectedEndOfStream);
        }
        
        let slice = &self.data[self.position..self.position + len];
        self.position += len;
        
        // XDR padding to 4-byte boundaries
        let padding = (4 - (len % 4)) % 4;
        if padding > 0 {
            if self.remaining() < padding {
                return Err(XdrError::UnexpectedEndOfStream);
            }
            // Verify padding is zero
            for &b in &self.data[self.position..self.position + padding] {
                if b != 0 {
                    return Err(XdrError::InvalidPadding);
                }
            }
            self.position += padding;
        }
        
        Ok(slice)
    }
    
    pub fn read_var_opaque(&mut self) -> Result<&'a [u8], XdrError> {
        let len = self.read_u32()? as usize;
        self.read_opaque(len)
    }

    /// Skips over a specific amount of bytes, handling standard 4-byte alignment
    /// if `aligned` is true. Useful for skipping unneeded XDR struct fields.
    pub fn skip(&mut self, len: usize, aligned: bool) -> Result<(), XdrError> {
        let mut total_skip = len;
        if aligned {
            let padding = (4 - (len % 4)) % 4;
            total_skip += padding;
        }
        self.advance(total_skip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_u32() {
        let data = [0x00, 0x00, 0x00, 0x2A];
        let mut cursor = Cursor::new(&data);
        assert_eq!(cursor.read_u32(), Ok(42));
    }

    #[test]
    fn test_read_i32() {
        let data = [0xFF, 0xFF, 0xFF, 0xFE];
        let mut cursor = Cursor::new(&data);
        assert_eq!(cursor.read_i32(), Ok(-2));
    }

    #[test]
    fn test_read_bool() {
        let data = [0x00, 0x00, 0x00, 0x01];
        let mut cursor = Cursor::new(&data);
        assert_eq!(cursor.read_bool(), Ok(true));
        
        let bad_data = [0x00, 0x00, 0x00, 0x02];
        let mut cursor_bad = Cursor::new(&bad_data);
        assert_eq!(cursor_bad.read_bool(), Err(XdrError::MalformedData));
    }

    #[test]
    fn test_read_var_opaque() {
        // Length 3, "ABC", padded with 1 zero byte
        let data = [0x00, 0x00, 0x00, 0x03, b'A', b'B', b'C', 0x00];
        let mut cursor = Cursor::new(&data);
        assert_eq!(cursor.read_var_opaque(), Ok("ABC".as_bytes()));
        assert_eq!(cursor.position(), 8);
    }

    #[test]
    fn test_unexpected_end_of_stream() {
        let data = [0x00, 0x00];
        let mut cursor = Cursor::new(&data);
        assert_eq!(cursor.read_u32(), Err(XdrError::UnexpectedEndOfStream));
    }
    
    #[test]
    fn test_invalid_padding() {
        // Length 3, "ABC", padded with 1 non-zero byte
        let data = [0x00, 0x00, 0x00, 0x03, b'A', b'B', b'C', 0x01];
        let mut cursor = Cursor::new(&data);
        assert_eq!(cursor.read_var_opaque(), Err(XdrError::InvalidPadding));
    }
}
