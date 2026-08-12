from fpdf import FPDF

try:
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("helvetica", size=10)
    pdf.cell(0, 10, "Test string with dash – and smart quotes “hello”")
    out = bytes(pdf.output())
    with open("test.pdf", "wb") as f:
        f.write(out)
    print("Success")
except Exception as e:
    print(f"Error: {e}")
