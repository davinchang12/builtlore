<select id="supplier" name="supplier_id"></select>
<select id="item" name="item_id"></select>
<script>
    $.post("{{ route('get_data.suppliers') }}", function (rows) { fill('#supplier', rows); });
    $('#supplier').on('change', function () {
        $.post("{{ url('/get_data/items') }}", { supplier_id: this.value }, function (rows) { fill('#item', rows); });
    });
</script>
